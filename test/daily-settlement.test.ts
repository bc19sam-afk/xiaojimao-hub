import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'
import type { DailyUsage } from '../lib/cpa.ts'
import type { SessionUser } from '../lib/session.ts'

// ============================================================================
// P2-R2（按日用量计量发分引擎，非破坏：加表+加逻辑）。两部分：
//   Part A —— migration 008 结构：v7 库跑迁移后 usage_rates + daily_settlements 两表在、版本到最新、
//             daily_settlements 的 UNIQUE(contribution_id, date) 生效。直接驱动 migrate/up、内存库。
//   Part B —— 折算 + 按日结算（走 lib/settle.ts settleDailyUsage，MOCK、单例连接）：折算精度、结算幂等
//             （核心）、只结算 pooled、多日、只结已过完自然日、MOCK 端到端发分、getDailyUsage 结构。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指向临时目录再动态 import；绝不碰真实 data/。
// ============================================================================

// ---------------------------- Part A：migration 008（内存库）----------------------------

function makeDbAt(target: number): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const m of migrations.filter((m) => m.version <= target).sort((a, b) => a.version - b.version)) {
    m.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(target)
  return d
}
function tableNames(d: DatabaseSync): Set<string> {
  const rows = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

test('迁移008：建 usage_rates + daily_settlements、版本到最新、按日结算幂等键生效', () => {
  assert.ok(migrations.some((m) => m.version === 8), '应存在 migration 008')
  const d = makeDbAt(7) // stamped v7 → migrate 只跑 008
  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)
  const names = tableNames(d)
  assert.ok(names.has('usage_rates'), '缺表 usage_rates')
  assert.ok(names.has('daily_settlements'), '缺表 daily_settlements')
  // UNIQUE(contribution_id, date)：同号同日二次插入必冲突（按日结算幂等的第一道闸）
  const ins = (pts: number) =>
    d.prepare(
      `INSERT INTO daily_settlements (contribution_id, date, provider, account_id, call_count, points, settled_at)
       VALUES ('c1','2026-07-19','codex','acc',10,?,1)`,
    ).run(pts)
  ins(10)
  assert.throws(() => ins(99), /UNIQUE|constraint/i, '同 (contribution_id, date) 应违反唯一约束')
  const n = d.prepare("SELECT COUNT(*) AS n FROM daily_settlements WHERE contribution_id='c1'").get() as { n: number }
  assert.equal(n.n, 1)
  d.close()
})

// ---------------------------- Part B：折算 + 结算（单例连接 / MOCK）----------------------------

let db: typeof import('../lib/db.ts').db
let settle: typeof import('../lib/settle.ts')
let cpa: typeof import('../lib/cpa.ts').cpa
let collect: typeof import('../lib/collect.ts')
let tmpDir: string

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

// 造号并落库；默认视为「入过池」（设 pooled_at＝结算资格判据，见 migration 010）——用 1（1970）
// 保证所有测试 date 都在进池之后、不被 settle 的 pooled_at 下界挡。pooled:false 造「从没入池」的号。
function seedC(over: Partial<Contribution>, opts: { pooled?: boolean } = {}): Contribution {
  const c = makeContribution(over)
  db.insertUnique(c)
  if (opts.pooled ?? true) db.update(c.id, { pooledAt: 1 })
  return c
}

// 桩掉 cpa.getDailyUsage（同一模块单例，settle.ts 看到的是同一对象）返回指定用量，跑完必还原——
// 与 pooled-statemachine 的 withInspect 同款，让日期/次数确定可控。
async function withUsage<T>(usage: DailyUsage[], fn: () => Promise<T>): Promise<T> {
  const orig = cpa.getDailyUsage
  cpa.getDailyUsage = async () => usage
  try {
    return await fn()
  } finally {
    cpa.getDailyUsage = orig
  }
}

// 直连临时库写一条用量单价（管理 CRUD 是 R3，这里为测折算精度用裸连接注入分数单价）
function setRate(provider: string, plan: string, ppc: number): void {
  const raw = new DatabaseSync(process.env.DB_PATH as string)
  raw.exec('PRAGMA busy_timeout = 5000')
  raw
    .prepare(
      `INSERT INTO usage_rates (provider, plan, points_per_call, enabled) VALUES (?,?,?,1)
       ON CONFLICT(provider, plan) DO UPDATE SET points_per_call=excluded.points_per_call, enabled=1`,
    )
    .run(provider, plan, ppc)
  raw.close()
}

// 本地时区 YMD（与 lib 内 dayStr 一致），供 e2e 判「昨天 < 今天」
function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-settle-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  settle = await import('../lib/settle.ts')
  ;({ cpa } = await import('../lib/cpa.ts'))
  collect = await import('../lib/collect.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ① 折算 ratePerCall：精确 > provider 兜底(*) > 无规则=0（种子：codex/plus=1、codex/pro=2、codex/*=1、claude/*=1）
test('折算 ratePerCall：精确 > provider 兜底 > 无规则=0', () => {
  assert.equal(db.ratePerCall('codex', 'pro'), 2) // 精确
  assert.equal(db.ratePerCall('codex', 'plus'), 1) // 精确
  assert.equal(db.ratePerCall('codex', 'team'), 1) // 无 codex/team → 兜底 codex/*
  assert.equal(db.ratePerCall('claude', 'whatever'), 1) // 兜底 claude/*
  assert.equal(db.ratePerCall('grok', 'super'), 1) // 兜底 grok/*
  assert.equal(db.ratePerCall('nobody', 'x'), 0) // 无任何规则=0
  assert.equal(db.ratePerCall('CODEX', 'PRO'), 2) // 大小写不敏感（仿 pointsFor）
})

// ② 折算 round：单价为小数 → points = round(count × 单价)（point_ledger.delta 是整数）
test('折算 round：单价小数 → points=round(count×单价)', async () => {
  const uid = 7100
  const id = 'round-c'
  const accountId = 'round-account'
  setRate('codex', 'roundplan', 0.5) // 分数单价
  seedC({ id, provider: 'codex', accountId, plan: 'roundplan', linuxdoId: uid })
  assert.equal(db.ratePerCall('codex', 'roundplan'), 0.5)
  // count=3 → round(3×0.5)=round(1.5)=2
  await withUsage([{ accountId, provider: 'codex', date: '2020-01-01', count: 3 }], () => settle.settleDailyUsage(undefined, { force: true }))
  const s = db.settlementsFor(id)
  assert.equal(s.length, 1)
  assert.equal(s[0].points, 2)
  assert.equal(s[0].callCount, 3)
  assert.equal(db.balance(uid), 2)
})

// ③ 结算幂等（核心）：同号同日 settleDailyUsage 跑两次 → 只发一次分（settlement 一行、ledger 一笔、余额只加一次）
test('结算幂等：同号同日跑两次 → 一笔 settlement、余额只加一次', async () => {
  const uid = 7001
  const id = 'idem-c'
  const accountId = 'idem-account'
  seedC({ id, provider: 'codex', accountId, plan: 'plus', linuxdoId: uid })
  const usage: DailyUsage[] = [{ accountId, provider: 'codex', date: '2020-01-02', count: 10 }]
  const r1 = await withUsage(usage, () => settle.settleDailyUsage(undefined, { force: true }))
  const r2 = await withUsage(usage, () => settle.settleDailyUsage(undefined, { force: true }))
  assert.deepEqual({ settled: r1.settled, awarded: r1.awarded }, { settled: 1, awarded: 1 }) // 首轮结算+发分
  assert.deepEqual({ settled: r2.settled, awarded: r2.awarded }, { settled: 0, awarded: 0 }) // 次轮 hasSettled 跳过
  assert.equal(db.settlementsFor(id).length, 1) // 只一笔
  assert.equal(db.balance(uid), 10) // codex/plus=1 → 10×1=10，只加一次
})

// ④ 结算资格＝**入过池**（pooled_at 非空），不看当前态（codex xhigh 于 PR #18）：入过池的 stopped/
//    needs_review 补结历史欠薪；**从没入池**的号（含首检 reauth 直接转的 needs_review）绝不结算
test('结算资格：入过池的 stopped/needs_review 补结；从没入池的（含 needs_review）不结', async () => {
  // 从没入池（pooled:false → 无 pooled_at）：first_check / submitted / **首检直转的 needs_review**
  const noPay = [
    { st: 'first_check' as const, uid: 7012, acc: 'np-first' },
    { st: 'submitted' as const, uid: 7014, acc: 'np-sub' },
    { st: 'needs_review' as const, uid: 7015, acc: 'np-review-nopool' }, // 首检 reauth 直转、从没入池
  ]
  for (const s of noPay) {
    seedC({ id: 'id-' + s.acc, provider: 'grok', accountId: s.acc, plan: 'super', linuxdoId: s.uid, verifyStatus: s.st }, { pooled: false })
  }
  // 入过池后转态（pooled:true → 有 pooled_at）：stopped（存活巡检失效）/ needs_review（巡检 reauth）→ 补结欠薪
  seedC({ id: 'id-p-stopped', provider: 'grok', accountId: 'p-stopped', plan: 'super', linuxdoId: 7011, verifyStatus: 'stopped' })
  seedC({ id: 'id-p-review', provider: 'grok', accountId: 'p-review', plan: 'super', linuxdoId: 7013, verifyStatus: 'needs_review' })
  const usage: DailyUsage[] = [
    ...noPay.map((s) => ({ accountId: s.acc, provider: 'grok' as const, date: '2020-01-03', count: 20 })),
    { accountId: 'p-stopped', provider: 'grok', date: '2020-01-03', count: 20 },
    { accountId: 'p-review', provider: 'grok', date: '2020-01-03', count: 20 },
  ]
  const r = await withUsage(usage, () => settle.settleDailyUsage(undefined, { force: true }))
  assert.equal(r.settled, 2) // 只有两个「入过池」的结了
  for (const s of noPay) {
    assert.equal(db.settlementsFor('id-' + s.acc).length, 0, `${s.st}（从没入池）不应结算`)
    assert.equal(db.balance(s.uid), 0)
  }
  assert.equal(db.settlementsFor('id-p-stopped').length, 1, '入过池的 stopped 应补结历史日')
  assert.ok(db.balance(7011) > 0)
  assert.equal(db.settlementsFor('id-p-review').length, 1, '入过池的 needs_review 应补结历史日')
  assert.ok(db.balance(7013) > 0)
})

// ⑤ 多日：号有多个未结算日 → 各结一笔、各发分；已结算日不重结（新增日才结）
test('多日：多个未结算日各结一笔各发分；已结算日不重结', async () => {
  const uid = 7021
  const id = 'multi-c'
  const accountId = 'multi-account'
  seedC({ id, provider: 'grok', accountId, plan: 'super', linuxdoId: uid }) // grok/*=1
  const days: DailyUsage[] = [
    { accountId, provider: 'grok', date: '2020-02-01', count: 5 },
    { accountId, provider: 'grok', date: '2020-02-02', count: 7 },
    { accountId, provider: 'grok', date: '2020-02-03', count: 9 },
  ]
  const r1 = await withUsage(days, () => settle.settleDailyUsage(undefined, { force: true }))
  assert.equal(r1.settled, 3)
  assert.equal(r1.awarded, 3)
  assert.equal(db.settlementsFor(id).length, 3)
  assert.equal(db.balance(uid), 5 + 7 + 9) // 21

  // 重复旧三日 + 新增一日 → 只结新增日
  const more: DailyUsage[] = [...days, { accountId, provider: 'grok', date: '2020-02-04', count: 4 }]
  const r2 = await withUsage(more, () => settle.settleDailyUsage(undefined, { force: true }))
  assert.equal(r2.settled, 1)
  assert.equal(r2.awarded, 1)
  assert.equal(db.settlementsFor(id).length, 4)
  assert.equal(db.balance(uid), 21 + 4) // 25
})

// ⑥ 只结算已过完自然日：昨天结、今天/明天不结（§3.3 结算前一自然日）。用固定 now 锚定确定性
test('只结算已过完自然日：昨天结算、今天与未来日不结', async () => {
  const uid = 7031
  const id = 'today-c'
  const accountId = 'today-account'
  seedC({ id, provider: 'codex', accountId, plan: 'plus', linuxdoId: uid })
  const now = new Date(2026, 6, 20, 12).getTime() // 2026-07-20 12:00 本地 → today='2026-07-20'
  const usage: DailyUsage[] = [
    { accountId, provider: 'codex', date: '2026-07-19', count: 8 }, // 昨天 → 结
    { accountId, provider: 'codex', date: '2026-07-20', count: 5 }, // 今天 → 不结
    { accountId, provider: 'codex', date: '2026-07-21', count: 3 }, // 明天 → 不结
  ]
  const r = await withUsage(usage, () => settle.settleDailyUsage(now, { force: true }))
  assert.equal(r.settled, 1)
  const s = db.settlementsFor(id)
  assert.equal(s.length, 1)
  assert.equal(s[0].date, '2026-07-19')
  assert.equal(db.balance(uid), 8)
})

// ⑦ MOCK 端到端：交号(collect) → 首检入池 pooled(processPending) → settleDailyUsage → 号主余额增加、
//    daily_settlements 有笔、排行榜/名次反映。用真实 mock getDailyUsage（不桩）打通全链。
test('MOCK 端到端：交号 → 入池 → 按日结算 → 余额增加、settlement 有笔、排行榜反映', async () => {
  const user: SessionUser = { id: 7041, username: 'e2e-user', trustLevel: 3 }
  // 交号（claude 走 redirect：mock 造号 + 记 contribution submitted）
  const res = await collect.finishOAuth(user, 'claude', 'https://auth.example/cb?state=e2e-state')
  if (!res.ok) throw new Error('交号应成功：' + res.error)
  const cid = res.contribution.id
  const accountId = res.contribution.accountId
  assert.equal(db.balance(7041), 0)

  // 首检 → 入池 pooled（claude OAuth 成功即视为能用，直接入池）
  await collect.processPending()
  const pooled = db.byUser(7041).find((c) => c.id === cid)
  assert.ok(pooled)
  assert.equal(pooled.verifyStatus, 'pooled')
  assert.equal(db.balance(7041), 0) // 入池尚未结算
  // 回拨 pooled_at 到 3 天前：模拟号早就在池（否则「今天入池」时 pooled_at=今天，会把「昨天」的用量
  // 当作进池前用量按下界挡掉——那是正确语义，但本 e2e 要演示历史日发分，故让它早入池）。
  db.update(cid, { pooledAt: Date.now() - 3 * 86_400_000 })

  // 真实 mock getDailyUsage：该号「昨天」+「今天」各一笔；结算只发昨天
  const today = ymd(Date.now())
  const y = (await cpa.getDailyUsage()).find((u) => u.accountId === accountId && u.date < today)
  assert.ok(y, '应有该号昨天的用量')
  const expected = Math.round(y.count * db.ratePerCall('claude', pooled.plan))
  assert.ok(expected > 0, '演示需可见发分')

  await settle.settleDailyUsage(undefined, { force: true })
  assert.equal(db.balance(7041), expected) // 主余额增加
  const s = db.settlementsFor(cid)
  assert.equal(s.length, 1) // 只结昨天（今天进行中不结）
  assert.equal(s[0].points, expected)
  assert.equal(s[0].date, y.date)

  // 排行榜 / 名次反映（P5-R1 累计获得积分口径：该号已结算发分 expected>0，故上榜、名次积分≥1）
  assert.ok(db.leaderboard(50).some((e) => e.linuxdoId === 7041), '排行榜应含该贡献者')
  assert.ok(db.myRank(7041).points >= 1)

  // 幂等重跑：余额岿然不动、settlement 仍一笔
  await settle.settleDailyUsage(undefined, { force: true })
  assert.equal(db.balance(7041), expected)
  assert.equal(db.settlementsFor(cid).length, 1)
})

// ⑧ getDailyUsage mock 结构：每号每日一 count、date=YYYY-MM-DD、同号昨天+今天各一笔、count 稳定
test('getDailyUsage mock 结构：按号按日 count、YYYY-MM-DD、昨天+今天各一笔且稳定', async () => {
  const ing = await cpa.finishOAuth('codex', 'https://x?state=struct-1', [], new Set())
  const mine = (await cpa.getDailyUsage()).filter((u) => u.accountId === ing.accountId)
  assert.equal(mine.length, 2) // 昨天 + 今天
  for (const u of mine) {
    assert.match(u.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(u.provider, 'codex')
    assert.ok(u.count > 0)
  }
  const dates = mine.map((u) => u.date).sort()
  assert.ok(dates[0] < dates[1], '昨天 < 今天')
  // 稳定：再拉一次同号 count 不变（按 accountId hash 稳定编造）
  const again = (await cpa.getDailyUsage()).filter((u) => u.accountId === ing.accountId)
  assert.deepEqual(again.map((u) => u.count).sort(), mine.map((u) => u.count).sort())
})

// ⑩ 一天一次节流（codex xhigh 于 PR #16 指出：usage 是 ~19MB 全量流，8s tick 每轮拉＝~205GB/天）：
//    非 force 下同一天第二次调用直接 skip（不再拉 usage）；日切延迟（00:00–00:10）内也 skip
test('节流：同日第二次 settleDailyUsage 跳过；日切后 10 分钟内跳过', async () => {
  // 用「明天中午」保证与其他测试的 lastRunDay 无相互影响
  const base = new Date()
  const noonTomorrow = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 12).getTime()
  const r1 = await withUsage([], () => settle.settleDailyUsage(noonTomorrow)) // 非 force：真正跑（空 usage）
  assert.ok(!r1.skipped)
  const r2 = await withUsage([], () => settle.settleDailyUsage(noonTomorrow)) // 同日第二次 → skip
  assert.equal(r2.skipped, true)
  // 日切延迟：后天 00:05（新的一天、但在 10 分钟窗口内）→ skip
  const early = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 2, 0, 5).getTime()
  const r3 = await withUsage([], () => settle.settleDailyUsage(early))
  assert.equal(r3.skipped, true)
  // 后天 00:15（过了延迟窗）→ 真正跑
  const r4 = await withUsage([], () => settle.settleDailyUsage(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 2, 0, 15).getTime()))
  assert.ok(!r4.skipped)
})

// ⑨ 入池当日不结、次日起结（codex 于 PR #18 复审）：cpamp getDailyUsage 按自然日给量，入池当日那笔混了
//    「入池前号主自用」，无法按小时拆分 → 保守整日不结（settle 下界 '<='）。入池当日=前天、量不结；昨天量结。
test('入池当日不结、次日起结：pooled_at 当天 u.date 被下界挡、次日照发', async () => {
  const uid = 7090
  const id = 'settle-poolday'
  const accountId = 'poolday-acc'
  const now = Date.now()
  const poolDay = now - 2 * 86_400_000 // 前天＝入池当日
  const nextDay = now - 1 * 86_400_000 // 昨天＝入池次日
  seedC({ id, provider: 'grok', accountId, plan: 'super', linuxdoId: uid }) // grok/*=1 分/次
  db.update(id, { pooledAt: poolDay }) // 精确设入池当日
  const usage = [
    { accountId, provider: 'grok', date: ymd(poolDay), count: 5 }, // 入池当日 → 不结（'<=' 下界挡）
    { accountId, provider: 'grok', date: ymd(nextDay), count: 3 }, // 次日 → 结
  ]
  const r = await withUsage(usage, () => settle.settleDailyUsage(undefined, { force: true }))
  assert.equal(r.settled, 1) // 只结次日一笔
  assert.equal(db.balance(uid), 3) // 只发次日 3 次 × 1，入池当日 5 次不算
  assert.equal(db.settlementsFor(id).length, 1)
})
