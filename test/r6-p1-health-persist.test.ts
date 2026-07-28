import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AuthFile, ProbeResult } from '../lib/cpa.ts'
import type { Contribution } from '../lib/db.ts'

// ============================================================================
// R6-P1①：存活巡检失败未跨节流窗持久化（codex R5 终审）
//
// 问题：checkPooledHealth 在 try 开头就推进 lastHealthAt → 失败时下一个 8s tick 被节流 early
// return、只回 { skipped: true }、缺 inspectFailed → worker.healthIsHealthy 判健康 →
// 持续故障期每 5 分钟窗只有首 tick 抑制心跳、后续 ~36 tick 照打 → dead-man 假绿。
//
// 修复：模块级新增 lastInspectFailed 标志。本轮真跑时在 finally 更新它（成功清零/失败保持），
// throttled skip 时从此标志传播 inspectFailed → 故障期所有 tick 都判不健康，直到下次真跑成功
// 才清零 → 心跳在整个故障窗持续抑制。
//
// 隔离红线：DB_PATH 指临时目录、before() 动态 import。
// ============================================================================

let tmpDir: string
let db: typeof import('../lib/db.ts').db
let collect: typeof import('../lib/collect.ts')
let worker: typeof import('../lib/worker.ts')
let cpa: typeof import('../lib/cpa.ts').cpa

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6p1-'))
  process.env.DB_PATH = path.join(tmpDir, 'test.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa')
  ;({ db } = await import('../lib/db.ts'))
  collect = await import('../lib/collect.ts')
  worker = await import('../lib/worker.ts')
  ;({ cpa } = await import('../lib/cpa.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeContribution(over: Partial<Contribution>): Contribution {
  const now = Date.now()
  return {
    id: 'id-' + Math.random().toString(16).slice(2),
    linuxdoId: 1,
    username: 'u',
    accountId: 'acc',
    email: 'e@example.com',
    provider: 'codex',
    plan: 'plus',
    method: 'oauth',
    authFileName: 'f.json',
    verifyStatus: 'pooled',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

async function withCpa<T>(
  over: { probes?: ProbeResult[]; probesThrow?: boolean; files?: AuthFile[]; filesThrow?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  const oi = cpa.inspect
  const ol = cpa.listAuthFiles
  cpa.inspect = async () => {
    if (over.probesThrow) throw new Error('inspect down')
    return over.probes ?? []
  }
  cpa.listAuthFiles = async () => {
    if (over.filesThrow) throw new Error('listAuthFiles down')
    return over.files ?? []
  }
  try {
    return await fn()
  } finally {
    cpa.inspect = oi
    cpa.listAuthFiles = ol
  }
}

const authFile = (provider: string, accountId: string): AuthFile => ({
  name: `${provider}-${accountId}.json`,
  accountId,
  email: '',
  plan: 'x',
  disabled: false,
  provider: provider as AuthFile['provider'],
})

// R6-P1①-主修：持续 CPA 故障期间，所有 throttled tick 的健康信号都应反映真实故障（inspectFailed=true），
// 而非只有每 5 分钟窗的首 tick 置位。
test('R6-P1①：CPA 巡检故障期间节流窗内所有 tick 都判不健康（防 dead-man 假绿）', async () => {
  collect.__resetHealthThrottle() // 清空任何前测留下的状态
  const id = 'r6p1-persist-fail'
  db.insertUnique(makeContribution({ id, provider: 'grok', accountId: 'r6p1-acc', plan: 'super', linuxdoId: 9001 }))

  const base = Date.now()
  // 首次真跑，CPA listAuthFiles 抛错 → inspectFailed=true、lastInspectFailed 置 true
  const r1 = await withCpa({ filesThrow: true }, () => collect.checkPooledHealth(base, { force: true }))
  assert.equal(r1.inspectFailed, true, '🔴 首次失败必须置健康信号')
  assert.equal(worker.healthIsHealthy(r1), false, '🔴 消费侧据此判不健康 → 本轮不发心跳')

  // 窗内后续 tick（<5min）：被节流 skip，但仍须传播上次真跑的失败状态
  const r2 = await withCpa({ files: [] }, () => collect.checkPooledHealth(base + 30_000)) // 30s 后
  assert.equal(r2.skipped, true, '节流窗内第二次调用应 skip')
  assert.equal(r2.inspectFailed, true, '🔴 R6-P1① 核心：throttled tick 也要传播上次失败 → 故障持续期心跳持续抑制')
  assert.equal(worker.healthIsHealthy(r2), false, '🔴 消费侧判不健康')

  // 窗内第三次（模拟连续 8s tick：第 0s、第 8s、第 16s……）
  const r3 = await withCpa({ files: [] }, () => collect.checkPooledHealth(base + 60_000)) // 1min 后
  assert.equal(r3.skipped, true)
  assert.equal(r3.inspectFailed, true, '🔴 故障未恢复前，每个 throttled tick 都该看到失败')
  assert.equal(worker.healthIsHealthy(r3), false)

  // 下一窗首 tick（6min 后）真跑，CPA 恢复 → 清零 lastInspectFailed
  const r4 = await withCpa({ files: [authFile('grok', 'r6p1-acc')] }, () =>
    collect.checkPooledHealth(base + 6 * 60_000),
  )
  assert.ok(!r4.skipped, '超窗后重新真跑')
  assert.ok(!r4.inspectFailed, 'CPA 恢复，本轮成功')
  assert.equal(worker.healthIsHealthy(r4), true, '恢复后判健康')

  // 恢复窗内 throttled tick：传播上次真跑的成功状态（inspectFailed 缺省 undefined ＝健康）
  const r5 = await withCpa({ files: [] }, () => collect.checkPooledHealth(base + 6 * 60_000 + 30_000))
  assert.equal(r5.skipped, true)
  assert.ok(!r5.inspectFailed, '🔴 成功后 throttled tick 也该传播清零状态 → 心跳可发')
  assert.equal(worker.healthIsHealthy(r5), true)
})

// R6-P1① 纵深：空池 early return 也要更新标志，否则「故障期间池子恰好清空」会把 true 永久钉住
test('R6-P1①：空池 early return 也清零失败标志（防永久钉住）', async () => {
  collect.__resetHealthThrottle()
  const id = 'r6p1-empty-trap'
  db.insertUnique(makeContribution({ id, provider: 'grok', accountId: 'r6p1-empty-acc', plan: 'super', linuxdoId: 9002 }))

  const base = Date.now()
  // 先制造一次失败 → lastInspectFailed = true
  await withCpa({ filesThrow: true }, () => collect.checkPooledHealth(base, { force: true }))

  // 清空池（模拟运维手动停用所有号、或全部转其它状态）。⚠️ 同进程前一条测试的号也还在池里，
  // 必须全清，否则 pooled.length !== 0、走不到本测试要钉的 early return 分支。
  for (const c of db.byVerifyStatus(['pooled'])) db.transition(c.id, ['pooled'], 'stopped')
  assert.equal(db.byVerifyStatus(['pooled']).length, 0, '前置：池必须真空了')

  // 下一窗真跑，pooled.length === 0 → early return。修复前此时 lastInspectFailed 保持 true，
  // 后续 throttled tick 永远传播 inspectFailed=true → 心跳再也不发（即使 CPA 早已恢复）。
  const r = await withCpa({ files: [] }, () => collect.checkPooledHealth(base + 6 * 60_000, { force: true }))
  assert.equal(r.checked, 0)
  assert.equal(r.stopped, 0)
  assert.ok(!r.inspectFailed, '空池 early return 时 inspectFailed 应为 false（本轮没活干＝没故障可报）')

  // 后续 throttled tick：传播上次真跑的清零状态
  const r2 = await withCpa({ files: [] }, () => collect.checkPooledHealth(base + 6 * 60_000 + 30_000))
  assert.equal(r2.skipped, true)
  assert.ok(!r2.inspectFailed, '🔴 空池后 throttled tick 也须传播清零 → 心跳可发（不被历史故障钉住）')
  assert.equal(worker.healthIsHealthy(r2), true)
})

// ============================================================================
// R7-P2④（codex R6 指出）：任何抛错的巡检轮次都要跨节流窗记为失败
//
// 问题：lastHealthAt 在 try 开头就推进，而 db.byVerifyStatus / db.transition 等**非 CPA** 操作
// 抛错时 inspectFailed 还是 false → finally 把这个 false 存进 lastInspectFailed → worker 只压掉
// 当前这一次心跳（异常本身会让 tick 的 catch 判不健康），之后 5 分钟节流窗内**全部报健康**，
// 即使故障还在。等于 R6-P1① 修的那个假绿换了个入口又回来了。
//
// 选型说明：总指挥倾向 (b)「只在扫描成功后才推进 lastHealthAt」，本轮选 (a)「抛错的轮次记为失败」。
// 理由：(b) 会让**故障期间彻底失去节流**——每个 8s tick 都重新真跑、每轮都打 CPA/DB，正是
// HEALTH_INTERVAL_MS 当初要防的持续满负荷（PR #18 的 codex xhigh 意见）；DB 抛错时还会变成
// 每 8s 一次的重试风暴。(a) 保住节流语义，且健康信号同样在整个故障窗持续为真，两个目标都达成。
// ============================================================================

test('R7-P2④：DB 操作抛错的轮次 → 跨节流窗都判不健康', async () => {
  collect.__resetHealthThrottle()
  for (const c of db.byVerifyStatus(['pooled'])) db.transition(c.id, ['pooled'], 'stopped')
  db.insertUnique(
    makeContribution({ id: 'r7p2d-1', provider: 'grok', accountId: 'r7p2d-acc', plan: 'super', linuxdoId: 9105 }),
  )

  const base = Date.now()
  // 让 byVerifyStatus 抛错（模拟库损坏/锁超时/磁盘故障）
  const orig = db.byVerifyStatus
  ;(db as unknown as { byVerifyStatus: unknown }).byVerifyStatus = () => {
    throw new Error('db down')
  }
  let threw = false
  try {
    await collect.checkPooledHealth(base, { force: true })
  } catch {
    threw = true
  } finally {
    ;(db as unknown as { byVerifyStatus: unknown }).byVerifyStatus = orig
  }
  assert.equal(threw, true, '前置：DB 抛错应向上抛（tick 的 catch 会判不健康）')

  // 🔴 核心：故障后节流窗内的 tick 必须仍判不健康。修复前 lastInspectFailed 被存成 false → 全报健康。
  const r2 = await withCpa({ files: [authFile('grok', 'r7p2d-acc')] }, () =>
    collect.checkPooledHealth(base + 30_000),
  )
  assert.equal(r2.skipped, true, '节流窗内应 skip')
  assert.equal(
    r2.inspectFailed,
    true,
    '🔴 R7-P2④ 核心：抛错的轮次要记为失败，否则窗内后续 ~36 个 tick 全报健康（假绿）',
  )
  assert.equal(worker.healthIsHealthy(r2), false, '🔴 消费侧判不健康 → 心跳持续抑制')

  // 下一窗真跑成功 → 清零
  const r3 = await withCpa({ files: [authFile('grok', 'r7p2d-acc')] }, () =>
    collect.checkPooledHealth(base + 6 * 60_000),
  )
  assert.ok(!r3.skipped, '超窗后重新真跑')
  assert.ok(!r3.inspectFailed, '真跑成功 → 清零')
  assert.equal(worker.healthIsHealthy(r3), true, '恢复后判健康')
})

test('R7-P2④：抛错后节流仍然生效（不退化成每 tick 重跑）', async () => {
  collect.__resetHealthThrottle()
  for (const c of db.byVerifyStatus(['pooled'])) db.transition(c.id, ['pooled'], 'stopped')
  db.insertUnique(
    makeContribution({ id: 'r7p2d-2', provider: 'grok', accountId: 'r7p2d-acc2', plan: 'super', linuxdoId: 9106 }),
  )

  const base = Date.now()
  const orig = db.byVerifyStatus
  ;(db as unknown as { byVerifyStatus: unknown }).byVerifyStatus = () => {
    throw new Error('db down')
  }
  try {
    await collect.checkPooledHealth(base, { force: true }).catch(() => {})
  } finally {
    ;(db as unknown as { byVerifyStatus: unknown }).byVerifyStatus = orig
  }

  // 选型 (a) 的直接后果、也是选它的理由：lastHealthAt 已推进 ⇒ 窗内不再真打 CPA。
  // 若改用 (b)（抛错就不推进时间戳），下面这次会真跑 → 故障期每 8s 一次重试风暴。
  let inspectCalls = 0
  const oi = cpa.inspect
  const ol = cpa.listAuthFiles
  cpa.inspect = async () => {
    inspectCalls++
    return []
  }
  cpa.listAuthFiles = async () => {
    inspectCalls++
    return []
  }
  try {
    const r = await collect.checkPooledHealth(base + 30_000)
    assert.equal(r.skipped, true, '🔴 抛错后窗内仍须节流（保住 HEALTH_INTERVAL_MS 的初衷）')
  } finally {
    cpa.inspect = oi
    cpa.listAuthFiles = ol
  }
  assert.equal(inspectCalls, 0, '🔴 节流窗内不得再打 CPA（否则故障期变成每 8s 一次满负荷）')
})
