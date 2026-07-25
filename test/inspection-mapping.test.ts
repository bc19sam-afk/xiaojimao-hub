import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Contribution } from '../lib/db.ts'
import type { ProbeResult } from '../lib/cpa.ts'

// ============================================================================
// 对接-R2c：mapInspection 的两个缺陷（依据 = 用户实例实跑的发行版 seakee/CPA-Manager-Plus 源码）
//
//   缺陷一 —— 探测失败被误判成健康：service.go 里 missing_auth_index（没探）/ request_error
//     （请求异常）/ missing_status（应答无 status_code）/ http_status（非 2xx）四种都标
//     action=keep（cpamp 只是「保守保留、别乱动」），旧判定链 `r.action === 'keep'` 无条件短路成
//     ok → 从没被成功探测过的号直接入池锁唯一键、开始计量发分。改为 fail-closed 判 retry。
//     ⚠️ 例外：xai_probe.go 复用 errorKind 字段装**健康分类**（inference_healthy /
//     official_api_healthy / billing_healthy / billing_partial），必须白名单放行为 ok，否则将来
//     开 xai 巡检后健康 grok 号永远入不了池、号主零收益。
//
//   缺陷二 —— ProbeResult 缺 provider：cpamp CodexInspectionResult 有 provider 字段、且巡检请求
//     已升级成 TargetTypes []string（白名单含 codex 与 xai）＝多 provider 结果已是现实可能。消费
//     方旧用裸 accountId 建索引 → 跨 provider 同 id 会把 A 家判定套到 B 家号上。改按 (provider,
//     accountId) 复合键，并对「老版本不返回 provider」保留回落（否则静默零收益）。
//
// ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指向临时目录再动态 import；绝不碰真实 data/。
// ⚠️ 本文件零真实实例调用：mapInspection 是纯函数，端到端部分走 MOCK + 桩 cpa.inspect。
// ============================================================================

let mapInspection: typeof import('../lib/cpa.ts').mapInspection
let db: typeof import('../lib/db.ts').db
let collect: typeof import('../lib/collect.ts')
let cpa: typeof import('../lib/cpa.ts').cpa
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-inspect-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ mapInspection, cpa } = await import('../lib/cpa.ts'))
  ;({ db } = await import('../lib/db.ts'))
  collect = await import('../lib/collect.ts')
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
    verifyStatus: 'submitted',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

// 桩掉 cpa.inspect（同一模块单例，collect.ts 看到的是同一对象）返回指定 probes，跑完必还原
async function withInspect<T>(probes: ProbeResult[], fn: () => Promise<T>): Promise<T> {
  const orig = cpa.inspect
  cpa.inspect = async () => probes
  try {
    return await fn()
  } finally {
    cpa.inspect = orig
  }
}

// ---------------------------- A：keep 守卫（缺陷一）----------------------------

// ① 四种「keep + 探测没拿到有效应答」→ retry（不是 ok）：这些号从没被证实能登录
test('keep 守卫：探测失败类 errorKind（未证实能登录）→ retry，不得当 ok 放行入池', () => {
  assert.equal(mapInspection({ action: 'keep', errorKind: 'request_error' }).decision, 'retry')
  assert.equal(mapInspection({ action: 'keep', errorKind: 'missing_status' }).decision, 'retry')
  assert.equal(mapInspection({ action: 'keep', errorKind: 'missing_auth_index' }).decision, 'retry')
  assert.equal(mapInspection({ action: 'keep', errorKind: 'http_status', statusCode: 403 }).decision, 'retry')
})

// ② xai 健康分类白名单（xai_probe.go 复用 errorKind 装健康结论）→ 仍判 ok，
//    否则将来开 xai 巡检后健康 grok 号永远入不了池、号主零收益
test('keep 守卫：xai 健康分类 errorKind（四值）→ ok，不被 fail-closed 误挡', () => {
  for (const kind of ['inference_healthy', 'official_api_healthy', 'billing_healthy', 'billing_partial']) {
    assert.equal(mapInspection({ action: 'keep', errorKind: kind }).decision, 'ok', `${kind} 应判 ok`)
  }
})

// ③ 回归：keep 无 errorKind＝正常保留 → ok（不破坏既有健康路径）
test('keep 守卫：keep 无 errorKind（正常保留）→ ok 不变', () => {
  assert.equal(mapInspection({ action: 'keep' }).decision, 'ok')
})

// ④ fail-closed 方向锁死：没见过的新 errorKind 一律 retry（retry 不判死，只是晚一轮）
test('keep 守卫 fail-closed：未知 errorKind（cpamp 将来新增）→ retry 而非 ok', () => {
  assert.equal(mapInspection({ action: 'keep', errorKind: 'some_future_kind_v9' }).decision, 'retry')
})

// ⑤ 回归：新子句不得挤掉既有优先级（quota/reject/reauth/enable/200/disable 全不变）
test('既有判定优先级不被 keep 守卫挤掉：enable/200/delete/401/relogin/disable/isQuota 行为不变', () => {
  assert.equal(mapInspection({ action: 'enable' }).decision, 'ok')
  assert.equal(mapInspection({ statusCode: 200 }).decision, 'ok')
  assert.equal(mapInspection({ action: 'delete' }).decision, 'reject')
  assert.equal(mapInspection({ statusCode: 401 }).decision, 'reject')
  assert.equal(mapInspection({ action: 'relogin' }).decision, 'reauth')
  assert.equal(mapInspection({ action: 'disable' }).decision, 'retry')
  assert.equal(mapInspection({ isQuota: true }).decision, 'retry')
  // keep 与更高优先级子句同时出现时，仍按更高优先级判（守卫插在 reauth 之后、ok 兜底之前）
  assert.equal(mapInspection({ action: 'keep', errorKind: 'invalidated' }).decision, 'reject')
  assert.equal(mapInspection({ action: 'keep', errorKind: 'reauth' }).decision, 'reauth')
  assert.equal(mapInspection({ action: 'keep', errorKind: 'request_error', isQuota: true }).decision, 'retry')
})

// ---------------------------- B：provider 归一（缺陷二）----------------------------

// ⑥ cpamp 发 "xai"、我方内部叫 "grok"：必须过 providerFromToken 归一，不准裸透传
test('provider 归一：xai→grok、codex→codex、claude→claude；认不出/缺失→undefined', () => {
  assert.equal(mapInspection({ accountId: 'a', provider: 'xai' }).provider, 'grok')
  assert.equal(mapInspection({ accountId: 'a', provider: 'codex' }).provider, 'codex')
  assert.equal(mapInspection({ accountId: 'a', provider: 'claude' }).provider, 'claude')
  assert.equal(mapInspection({ accountId: 'a', provider: 'anthropic' }).provider, 'claude')
  assert.equal(mapInspection({ accountId: 'a' }).provider, undefined) // 老版本不返回该字段
  assert.equal(mapInspection({ accountId: 'a', provider: 'wat' }).provider, undefined)
})

// ---------------------------- C：复合键端到端（MOCK，走 collect）----------------------------

// ⑦ 跨 provider 同 accountId：另一家（grok）的 reject 判定绝不能套到 codex 号上把它误退回
test('复合键：跨 provider 同 accountId — grok 的 reject 不误退回 codex 首检号', async () => {
  const uid = 6301
  const id = 'dup-codex'
  const accountId = 'dup-1'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  // 巡检只返回**grok** 家同 id 号的失效判定（codex 那个号本轮未被覆盖）
  await withInspect(
    [{ accountId, provider: 'grok', decision: 'reject', plan: 'super', reason: 'unauthorized' }],
    () => collect.processPending(),
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c, 'codex 号不得被另一 provider 的 reject 误删退回')
  assert.equal(c.verifyStatus, 'submitted') // 未覆盖＝跳过，保持原态下轮再检
})

// ⑧ 存活巡检同理：pooled 的 codex 号不被 grok 家同 id 的 reject 误停
test('复合键：存活巡检 — grok 的 reject 不误停同 accountId 的 pooled codex 号', async () => {
  const uid = 6302
  const id = 'dup-pooled-codex'
  const accountId = 'dup-2'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid, verifyStatus: 'pooled' }),
  )
  await withInspect(
    [{ accountId, provider: 'grok', decision: 'reject', plan: 'super', reason: 'unauthorized' }],
    () => collect.checkPooledHealth(Date.now(), { force: true }),
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'pooled') // 保持在池，未被误停
})

// ⑨ provider 匹配时照常生效（证明复合键不是「一律查不到」的假绿）
test('复合键：provider 相符的 reject 照常退回 codex 首检号', async () => {
  const uid = 6303
  const id = 'match-codex'
  const accountId = 'match-1'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  await withInspect(
    [{ accountId, provider: 'codex', decision: 'reject', plan: 'plus', reason: 'unauthorized' }],
    () => collect.processPending(),
  )
  assert.equal(db.byUser(uid).find((x) => x.id === id), undefined, 'provider 相符时 reject 应正常退回删行')
})

// ⑩ 老版本兼容回落：巡检结果不带 provider → 行为与本改动前完全一致（否则静默零收益）
test('老版本兼容：不带 provider 的巡检结果仍能匹配（ok→入池 / reject→退回）', async () => {
  const uid = 6304
  // ok → 照常入池
  const okId = 'legacy-ok'
  const okAcc = 'legacy-ok-acc'
  db.insertUnique(
    makeContribution({ id: okId, provider: 'codex', accountId: okAcc, authFileName: `codex-${okAcc}.json`, plan: 'plus', linuxdoId: uid }),
  )
  await withInspect([{ accountId: okAcc, decision: 'ok', plan: 'plus', reason: 'ok' }], () =>
    collect.processPending(),
  )
  assert.equal(db.byUser(uid).find((x) => x.id === okId)?.verifyStatus, 'pooled')

  // reject → 照常退回删行
  const rejId = 'legacy-reject'
  const rejAcc = 'legacy-reject-acc'
  db.insertUnique(
    makeContribution({ id: rejId, provider: 'codex', accountId: rejAcc, authFileName: `codex-${rejAcc}.json`, plan: 'plus', linuxdoId: uid }),
  )
  await withInspect([{ accountId: rejAcc, decision: 'reject', plan: 'plus', reason: 'unauthorized' }], () =>
    collect.processPending(),
  )
  assert.equal(db.byUser(uid).find((x) => x.id === rejId), undefined)
})

// ⑪ keep 守卫的下游行为（缺陷一的真价值）：探测异常的号留 first_check，不入池、不判死
test('端到端：keep+request_error 映射出的 retry → 留 first_check，不入池锁唯一键', async () => {
  const uid = 6305
  const id = 'keep-guard-e2e'
  const accountId = 'keep-guard-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  // 直接用 mapInspection 的产物喂 collect：keep+request_error → retry，reason 不命中限额词表
  const probe = mapInspection({
    accountId,
    provider: 'codex',
    action: 'keep',
    errorKind: 'request_error',
    actionReason: '探测异常，保留账号',
  })
  assert.equal(probe.decision, 'retry')
  await withInspect([probe], () => collect.processPending())
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c, '探测失败不判死：行必须保留')
  assert.equal(c.verifyStatus, 'first_check') // 未入池，下轮再查
  assert.equal(db.balance(uid), 0) // 未验证的号没有开始计量发分
})
