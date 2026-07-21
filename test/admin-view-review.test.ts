import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Contribution } from '../lib/db.ts'
import type { DailyUsage } from '../lib/cpa.ts'

// ============================================================================
// P4-R3 数据查看 + 人工复核处理（§6.146 / §7.4）：
//   A 贡献记录 listContributionsAdmin —— 分页/倒序/字段/累计发分 + 脱敏（无 email/reward_code）
//   B 每日结算 listSettlementsAdmin —— 倒序/JOIN 取归属人/孤儿行兜底
//   C 兑换记录 listRedemptionsAdmin —— 🔴 §8 脱敏（扫描无码 + 无 result 字段）+ username 子查询
//   D 人工复核 retryReview/terminateReview —— CAS 转态 + 拒非 needs_review + 🔴 幂等（不碰 settlements/ledger）
//   E 审计 auditContributionReview —— action/target/old/new + recordAudit 端到端
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指临时目录再**动态 import**；绝不碰真实 data/app.db。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let audit: typeof import('../lib/audit.ts')
let settle: typeof import('../lib/settle.ts')
let cpa: typeof import('../lib/cpa.ts').cpa
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-adminview-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  audit = await import('../lib/audit.ts')
  settle = await import('../lib/settle.ts')
  ;({ cpa } = await import('../lib/cpa.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// 桩掉 cpa.getDailyUsage（同一模块单例，settle.ts 看到同一对象）返回指定用量，跑完必还原——仿 config-p4r2
async function withUsage<T>(usage: DailyUsage[], fn: () => Promise<T>): Promise<T> {
  const orig = cpa.getDailyUsage
  cpa.getDailyUsage = async () => usage
  try {
    return await fn()
  } finally {
    cpa.getDailyUsage = orig
  }
}

// 造号并落库。id/accountId 默认唯一（seq 递增），可被 over 覆盖；email/rewardCode 带敏感值供脱敏测试。
let seq = 0
function mkContribution(over: Partial<Contribution>): Contribution {
  seq += 1
  const now = Date.now()
  const c: Contribution = {
    id: 'c-' + seq,
    linuxdoId: 1,
    username: 'u',
    accountId: 'acc-' + seq,
    email: 'secret@example.com',
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
  db.insertUnique(c)
  return c
}

// ---------------------------- A：贡献记录 ----------------------------

// A1 分页（limit/offset）+ 倒序（created_at DESC）+ 字段映射（首个测试：库空，3 行即全部，top-N 确定）
test('A1 listContributionsAdmin：分页 + 倒序 + 字段正确', () => {
  const base = 4_000_000_000_000 // 远期时间戳：令这 3 行恒为最新，与执行顺序无关
  const c1 = mkContribution({ linuxdoId: 7001, username: 'alice', provider: 'codex', plan: 'plus', accountId: 'A1', createdAt: base + 1 })
  const c2 = mkContribution({ linuxdoId: 7002, username: 'bob', provider: 'claude', plan: '*', accountId: 'A2', createdAt: base + 2 })
  const c3 = mkContribution({ linuxdoId: 7003, username: 'carol', provider: 'grok', plan: 'super', accountId: 'A3', createdAt: base + 3 })
  const top2 = db.listContributionsAdmin(2, 0)
  assert.deepEqual(top2.map((r) => r.id), [c3.id, c2.id], '倒序：最新在前，limit=2')
  const page = db.listContributionsAdmin(2, 1) // 跳过最新 1 条
  assert.deepEqual(page.map((r) => r.id), [c2.id, c1.id], 'offset 跳过最新')
  // 字段映射（取 c2）
  const row = db.listContributionsAdmin(50, 0).find((r) => r.id === c2.id)!
  assert.equal(row.linuxdoId, 7002)
  assert.equal(row.username, 'bob')
  assert.equal(row.provider, 'claude')
  assert.equal(row.plan, '*')
  assert.equal(row.accountId, 'A2')
  assert.equal(row.verifyStatus, 'submitted')
  assert.equal(row.createdAt, base + 2)
  assert.equal(row.points, 0, '无结算 → 累计 0')
})

// A2 points＝该号累计发分（daily_settlements 汇总）+ 脱敏（不返回 email / reward_code）
test('A2 listContributionsAdmin：points 累计发分 + 脱敏无 email/reward_code', () => {
  const c = mkContribution({ linuxdoId: 7100, accountId: 'PTS', email: 'topsecret@x.com', rewardCode: 'RC-SECRET-CODE', provider: 'codex', plan: 'plus' })
  db.recordSettlement({ contributionId: c.id, date: '2026-07-01', provider: 'codex', accountId: 'PTS', callCount: 3, points: 3 })
  db.recordSettlement({ contributionId: c.id, date: '2026-07-02', provider: 'codex', accountId: 'PTS', callCount: 7, points: 7 })
  const row = db.listContributionsAdmin(200, 0).find((r) => r.id === c.id)!
  assert.equal(row.points, 10, '3 + 7 = 10')
  assert.equal(row.points, db.contributionPoints(c.id), '与 contributionPoints 一致')
  // §8 脱敏：整行 JSON 既无 email 也无 reward_code
  const dump = JSON.stringify(row)
  assert.ok(!dump.includes('topsecret@x.com'), '不得含 email')
  assert.ok(!dump.includes('RC-SECRET-CODE'), '不得含 reward_code')
  assert.ok(!('email' in row), '无 email 字段')
  assert.ok(!('rewardCode' in row), '无 rewardCode 字段')
})

// ---------------------------- B：每日结算记录 ----------------------------

// B1 倒序（id DESC）+ LEFT JOIN 取 username/linuxdoId + 孤儿行（无对应号）兜底
test('B1 listSettlementsAdmin：倒序 + JOIN 取归属人 + 孤儿行兜底', () => {
  const c = mkContribution({ linuxdoId: 7200, username: 'dave', accountId: 'S1', provider: 'codex' })
  db.recordSettlement({ contributionId: c.id, date: '2026-06-01', provider: 'codex', accountId: 'S1', callCount: 5, points: 5 })
  db.recordSettlement({ contributionId: c.id, date: '2026-06-02', provider: 'codex', accountId: 'S1', callCount: 8, points: 8 })
  // 孤儿结算行：contribution_id 无对应号 → username 空、linuxdoId null
  db.recordSettlement({ contributionId: 'ghost-cid', date: '2026-06-03', provider: 'grok', accountId: 'S9', callCount: 1, points: 1 })
  const rows = db.listSettlementsAdmin(50, 0)
  // 倒序 id DESC：最后插入的 ghost 在最前
  assert.equal(rows[0].contributionId, 'ghost-cid', 'id DESC：最新在前')
  assert.equal(rows[0].username, '', '孤儿行 username 空串')
  assert.equal(rows[0].linuxdoId, null, '孤儿行 linuxdoId null')
  // 正常行 JOIN 到归属人 + 字段
  const norm = rows.find((r) => r.contributionId === c.id && r.date === '2026-06-02')!
  assert.equal(norm.username, 'dave')
  assert.equal(norm.linuxdoId, 7200)
  assert.equal(norm.provider, 'codex')
  assert.equal(norm.accountId, 'S1')
  assert.equal(norm.callCount, 8)
  assert.equal(norm.points, 8)
  // id DESC：后插的 06-02 排在先插的 06-01 之前
  const idxNewer = rows.findIndex((r) => r.contributionId === c.id && r.date === '2026-06-02')
  const idxOlder = rows.findIndex((r) => r.contributionId === c.id && r.date === '2026-06-01')
  assert.ok(idxNewer >= 0 && idxNewer < idxOlder, 'id DESC：后插的在前')
})

// ---------------------------- C：兑换记录（🔴 §8 脱敏）----------------------------

// C1 绝不返回 result（CDK 码）：扫描整个返回 JSON 无码 + 无 result 字段；username 子查询归属
test('C1 listRedemptionsAdmin：脱敏无码/无 result 字段 + username 子查询 + 倒序', () => {
  const CODE = 'CDK-SUPER-SECRET-9999'
  // 兑换用户有贡献号 → username 由子查询取到
  mkContribution({ linuxdoId: 7300, username: 'erin', accountId: 'R1', provider: 'codex' })
  db.createRedemption({ id: 'red-1', linuxdoId: 7300, itemId: 1, itemName: '永久额度', cost: 100, status: 'fulfilled', result: CODE })
  // 纯兑换用户（无贡献号）→ username 空、前端显示 linuxdoId 兜底
  db.createRedemption({ id: 'red-2', linuxdoId: 7999, itemId: 2, itemName: 'VIP', cost: 50, status: 'fulfilled', result: 'PLACEHOLDER-XYZ' })
  const rows = db.listRedemptionsAdmin(50, 0)
  // 🔴 §8：扫描整个返回，绝无任何 result 值，且结构上无 result 字段
  const dump = JSON.stringify(rows)
  assert.ok(!dump.includes(CODE), '绝不得含 CDK 码原文')
  assert.ok(!dump.includes('PLACEHOLDER-XYZ'), '绝不得含任何 result 值')
  for (const r of rows) assert.ok(!('result' in r), '无 result 字段')
  // 字段 + 归属
  const r1 = rows.find((r) => r.id === 'red-1')!
  assert.equal(r1.username, 'erin', '有贡献号 → 子查询取 username')
  assert.equal(r1.linuxdoId, 7300)
  assert.equal(r1.itemName, '永久额度')
  assert.equal(r1.cost, 100)
  assert.equal(r1.status, 'fulfilled')
  const r2 = rows.find((r) => r.id === 'red-2')!
  assert.equal(r2.username, '', '无贡献号 → username 空串')
  assert.equal(r2.linuxdoId, 7999)
  // 倒序（created_at DESC，id DESC 兜底）：后建的 red-2 在 red-1 前
  const i2 = rows.findIndex((r) => r.id === 'red-2')
  const i1 = rows.findIndex((r) => r.id === 'red-1')
  assert.ok(i2 >= 0 && i2 < i1, '倒序：后建的在前')
})

// ---------------------------- D：人工复核处理（🔴 §7.4 幂等）----------------------------

// D1 retryReview：needs_review→submitted + 幂等（settlements/ledger/balance 前后无变化）
test('D1 retryReview：needs_review→submitted + 幂等不碰结算/账本', () => {
  const uid = 7400
  const c = mkContribution({ id: 'nr-retry', linuxdoId: uid, accountId: 'NR1', provider: 'codex', verifyStatus: 'needs_review' })
  // 预置该号一笔结算 + 该用户一笔账本，证明动作绝不触碰这两张表
  db.recordSettlement({ contributionId: c.id, date: '2026-05-01', provider: 'codex', accountId: 'NR1', callCount: 4, points: 4 })
  db.awardPoints(uid, 4, 'usage', `usage:${c.id}:2026-05-01`)
  const s0 = db.settlementsFor(c.id).map((s) => [s.date, s.points])
  const b0 = db.balance(uid)
  const l0 = db.ledgerFor(uid).length
  assert.equal(b0, 4)
  // 动作：真转。此号从没入池（pooled_at null＝category①）→ 回首检 'submitted'
  assert.equal(db.retryReview(c.id), true, '真转')
  const after = db.all().find((x) => x.id === c.id)!
  assert.equal(after.verifyStatus, 'submitted', '从没入池 → submitted')
  assert.equal(after.pooledAt, undefined, '从没入池：pooled_at 仍 null（category①）')
  // 🔴 幂等铁律：settlements / balance / ledger 前后不变
  assert.deepEqual(db.settlementsFor(c.id).map((s) => [s.date, s.points]), s0, 'settlements 不变')
  assert.equal(db.balance(uid), b0, 'balance 不变')
  assert.equal(db.ledgerFor(uid).length, l0, 'ledger 笔数不变')
})

// D2 terminateReview：needs_review→stopped + 幂等（同 D1）
test('D2 terminateReview：needs_review→stopped + 幂等不碰结算/账本', () => {
  const uid = 7500
  const c = mkContribution({ id: 'nr-term', linuxdoId: uid, accountId: 'NR2', provider: 'grok', verifyStatus: 'needs_review' })
  db.recordSettlement({ contributionId: c.id, date: '2026-05-02', provider: 'grok', accountId: 'NR2', callCount: 6, points: 6 })
  db.awardPoints(uid, 6, 'usage', `usage:${c.id}:2026-05-02`)
  const s0 = db.settlementsFor(c.id).map((s) => [s.date, s.points])
  const b0 = db.balance(uid)
  const l0 = db.ledgerFor(uid).length
  assert.equal(db.terminateReview(c.id), true, '真转')
  assert.equal(db.all().find((x) => x.id === c.id)!.verifyStatus, 'stopped', '→ stopped')
  // 🔴 幂等铁律
  assert.deepEqual(db.settlementsFor(c.id).map((s) => [s.date, s.points]), s0, 'settlements 不变')
  assert.equal(db.balance(uid), b0, 'balance 不变')
  assert.equal(db.ledgerFor(uid).length, l0, 'ledger 笔数不变')
})

// D3 CAS 拒非 needs_review：对 pooled 号调 retry/terminate 返 false、态不变
test('D3 CAS 拒非 needs_review：pooled 号 retry/terminate 返 false、态不变', () => {
  const c = mkContribution({ id: 'pooled-x', accountId: 'PX', provider: 'codex', verifyStatus: 'pooled' })
  assert.equal(db.retryReview(c.id), false, 'pooled retry 返 false')
  assert.equal(db.terminateReview(c.id), false, 'pooled terminate 返 false')
  assert.equal(db.all().find((x) => x.id === c.id)!.verifyStatus, 'pooled', '态不变')
})

// ---------------------------- F：limit/offset 钳制（防脏输入，仿 listAudit）----------------------------

// F1 三个查询器均钳制：负 limit→1、负 offset→0、超大 limit→≤200；脏输入不抛（此时库已有多行）
test('F1 钳制：负 limit→1、负 offset→0、超大 limit→≤200', () => {
  // 负 limit → 下钳 1（Number(-5) 为真值，走 max(1,-5)=1）：三个查询器各恰返 1 行
  assert.equal(db.listContributionsAdmin(-5, 0).length, 1, '贡献：负 limit 钳 1')
  assert.equal(db.listSettlementsAdmin(-5, 0).length, 1, '结算：负 limit 钳 1')
  assert.equal(db.listRedemptionsAdmin(-5, 0).length, 1, '兑换：负 limit 钳 1')
  // 负 offset → 下钳 0：与 offset=0 同结果（取到最新一行）
  assert.deepEqual(
    db.listContributionsAdmin(1, -9).map((r) => r.id),
    db.listContributionsAdmin(1, 0).map((r) => r.id),
    '负 offset 钳 0',
  )
  // 超大 limit → 上钳 200，不抛；当前行数 < 200，故返回全部可用行
  const big = db.listContributionsAdmin(9999, 0)
  assert.ok(big.length <= 200, '上钳 200')
  assert.ok(big.length >= 3, '返回全部可用行')
})

// ---------------------------- E：审计 ----------------------------

// E1 auditContributionReview 构造器：toStatus 决定 new（去向真实）；retry→submitted/pooled、terminate→stopped
test('E1 auditContributionReview：toStatus 决定 new（三去向）', () => {
  const c = { provider: 'codex', accountId: 'acct_abc' }
  // 从没入池 retry → submitted
  const rSub = audit.auditContributionReview('contribution.retry', c, 'submitted')
  assert.equal(rSub.action, 'contribution.retry')
  assert.equal(rSub.target, 'codex/acct_abc', 'target=provider/accountId')
  assert.deepEqual(rSub.old, { verifyStatus: 'needs_review' })
  assert.deepEqual(rSub.new, { verifyStatus: 'submitted' })
  // 入过池 retry → pooled（去向必与真实一致，codex 复审 P1）
  const rPool = audit.auditContributionReview('contribution.retry', c, 'pooled')
  assert.deepEqual(rPool.new, { verifyStatus: 'pooled' }, '入过池 retry 审计 new=pooled')
  // terminate → stopped
  const term = audit.auditContributionReview('contribution.terminate', c, 'stopped')
  assert.equal(term.action, 'contribution.terminate')
  assert.equal(term.target, 'codex/acct_abc')
  assert.deepEqual(term.old, { verifyStatus: 'needs_review' })
  assert.deepEqual(term.new, { verifyStatus: 'stopped' })
})

// E2 端到端（category①）：从没入池 retry→submitted，recordAudit → listAudit 读回 new=submitted
test('E2 审计留痕端到端：从没入池 retry → listAudit new=submitted', () => {
  const actor = { type: 'linuxdo', id: 5, label: 'admin5' }
  const c = mkContribution({ accountId: 'AUD', provider: 'grok', verifyStatus: 'needs_review' })
  assert.equal(db.retryReview(c.id), true)
  const toStatus = c.pooledAt != null ? 'pooled' : 'submitted' // 路由同款口径：pooled_at null → submitted
  db.recordAudit(actor, audit.auditContributionReview('contribution.retry', c, toStatus))
  const row = db.listAudit(50, 0).find((r) => r.action === 'contribution.retry' && r.target === `grok/${c.accountId}`)
  assert.ok(row, '应有 contribution.retry 留痕')
  assert.equal(row!.actorId, 5)
  assert.deepEqual(JSON.parse(row!.oldValue as string), { verifyStatus: 'needs_review' })
  assert.deepEqual(JSON.parse(row!.newValue as string), { verifyStatus: 'submitted' })
})

// ---------------------------- G：codex 复审 3 条回归 ----------------------------

// G1 入过池 retry 直接回池（pooled_at 不动）+ 历史欠薪照补（codex 复审 P1，problem a）
test('G1 入过池 retry → pooled（pooled_at 不动）+ 欠薪照补', async () => {
  const uid = 7600
  const accountId = 'REPOOL'
  const poolDay = new Date(2026, 5, 10, 12).getTime() // 2026-06-10 12:00 本地＝原入池日
  const c = mkContribution({ id: 'nr-repool', linuxdoId: uid, accountId, provider: 'grok', plan: 'super', verifyStatus: 'pooled', createdAt: poolDay })
  db.update(c.id, { pooledAt: poolDay })
  // 模拟巡检 checkPooledHealth reauth：pooled → needs_review（pooled_at 仍非空＝category②）
  assert.equal(db.transition(c.id, ['pooled'], 'needs_review'), true)
  assert.equal(db.all().find((x) => x.id === c.id)!.pooledAt, poolDay, '转前 pooled_at＝原入池日')
  // retry：入过池 → 直接回池，绝不 submitted；pooled_at 原值不动
  assert.equal(db.retryReview(c.id), true, '真转')
  const after = db.all().find((x) => x.id === c.id)!
  assert.equal(after.verifyStatus, 'pooled', '入过池 → 直接回池（非 submitted，不进首检管道＝不删行/不覆写 pooled_at）')
  assert.equal(after.pooledAt, poolDay, 'pooled_at 原值不动（结算下界不移、欠薪不丢）')
  // 欠薪照补：一笔「原入池日之后、今天之前」的用量 → settle 该历史日结上（bug 下会被后移的 pooled_at 永久跳过）
  db.upsertUsageRate({ provider: 'grok', plan: 'super', pointsPerCall: 2, enabled: true, label: '' })
  const usage: DailyUsage[] = [{ accountId, provider: 'grok', date: '2026-06-12', count: 4 }]
  const settleNow = new Date(2026, 5, 15, 12).getTime() // 2026-06-15 12:00（过 grace 窗）
  await withUsage(usage, () => settle.settleDailyUsage(settleNow, { force: true }))
  const s = db.settlementsFor(c.id).find((x) => x.date === '2026-06-12')
  assert.ok(s, '入池日之后的历史欠薪日结上了')
  assert.equal(s!.points, 8, '4 次 × 2 = 8 补发')
  assert.equal(db.balance(uid), 8, '欠薪发到号主')
})

// G3 审计去向真实：入过池 retry 的审计 new={verifyStatus:'pooled'}（codex 复审 P1，路由 toStatus 口径）
test('G3 审计去向：入过池 retry → 审计 new=pooled', () => {
  const actor = { type: 'linuxdo', id: 6, label: 'admin6' }
  const poolDay = new Date(2026, 4, 20, 12).getTime()
  const c = mkContribution({ accountId: 'AUDPOOL', provider: 'codex', plan: 'plus', verifyStatus: 'pooled', createdAt: poolDay })
  db.update(c.id, { pooledAt: poolDay })
  db.transition(c.id, ['pooled'], 'needs_review')
  // 路由同款口径：c 在 CAS 前取，按 pooled_at 定 toStatus
  const snap = db.all().find((x) => x.id === c.id)!
  assert.equal(db.retryReview(c.id), true)
  const toStatus = snap.pooledAt != null ? 'pooled' : 'submitted'
  db.recordAudit(actor, audit.auditContributionReview('contribution.retry', snap, toStatus))
  const row = db.listAudit(50, 0).find((r) => r.action === 'contribution.retry' && r.target === 'codex/AUDPOOL')
  assert.ok(row, '应有留痕')
  assert.deepEqual(JSON.parse(row!.newValue as string), { verifyStatus: 'pooled' }, '入过池 retry 审计 new=pooled（与真实去向一致）')
})

// G4 offset=Infinity 不打穿钳制（四查询器含 listAudit 不抛、按 0 处理）（codex 复审 P3）
test('G4 offset=Infinity 不抛、按 0 处理（四查询器含 listAudit）', () => {
  // 修前：Number('Infinity')=Infinity 绕过 `||0`、Math.floor(Infinity)=Infinity 穿到 OFFSET 绑定抛错＝500
  const c = db.listContributionsAdmin(5, Infinity)
  assert.ok(Array.isArray(c), '贡献：offset=Infinity 不抛')
  assert.deepEqual(c.map((r) => r.id), db.listContributionsAdmin(5, 0).map((r) => r.id), '按 0 处理＝返回最新页')
  assert.ok(Array.isArray(db.listSettlementsAdmin(5, Infinity)), '结算：不抛')
  assert.ok(Array.isArray(db.listRedemptionsAdmin(5, Infinity)), '兑换：不抛')
  assert.ok(Array.isArray(db.listAudit(5, Infinity)), '审计（R1 同款一并修）：不抛')
})
