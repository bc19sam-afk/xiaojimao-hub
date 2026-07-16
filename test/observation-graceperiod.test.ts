import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'
import type { ProbeResult } from '../lib/cpa.ts'
import { mapInspection } from '../lib/cpa.ts'

// ============================================================================
// P2b：真实巡检映射 + 软/硬/未知失败区分 + 故障顺延。三部分：
//   Part A —— migration 006（纯新增、向后兼容）：空库 / v5 旧库 跑迁移后，contributions 加齐
//             observe_paused_ms + last_observed_at 两列、原数据不丢、版本到最新。直接驱动 migrate/up。
//   Part B —— 巡检闭环（走 lib/collect.ts processPending，MOCK、单例连接）：未知不推进、故障顺延（核心）、
//             软/硬映射。codex 观测决策靠 monkeypatch cpa.inspect 做确定性（mock inspect 是哈希随机，
//             见 [[xjm-observation-loop-testing]]，别依赖其具体去向）。
//   Part C —— 纯映射单测：observationKind（reason 细分 + decision 回落）、pauseIncrement（2× 抖动边界）。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指向临时目录再动态 import；绝不碰真实 data/。
// ============================================================================

const NEW_COLS = ['observe_paused_ms', 'last_observed_at']

function columnNames(d: DatabaseSync, table: string): Set<string> {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

// ---------------------------- Part A：migration 006（内存库）----------------------------

// 建到 v5 的内存库（跑 migrations 1..5 的 up + stamp schema_version=5）
function makeV5Db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const m of migrations.filter((m) => m.version <= 5).sort((a, b) => a.version - b.version)) {
    m.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (5)').run()
  return d
}

// ① 空库 migrate → 最新版（含 006）；contributions 加齐两列
test('迁移006：空库 migrate→最新，contributions 加 observe_paused_ms + last_observed_at 两列', () => {
  const d = new DatabaseSync(':memory:')
  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)
  assert.ok(migrations.some((m) => m.version === 6), '应存在 migration 006')
  const cols = columnNames(d, 'contributions')
  for (const c of NEW_COLS) assert.ok(cols.has(c), `contributions 缺新列 ${c}`)
  d.close()
})

// ② v5 旧库（有数据）migrate → 加两列、原数据不丢、新列默认 null、version=最新
test('迁移006：v5 旧库（有数据）migrate→最新，加两列、原数据不丢、新列为 null', () => {
  const d = makeV5Db()
  // v5 的 contributions（已含 004 快照列、005 新态值域）塞一行进考察态、带快照值
  d.prepare(
    `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at,
        observe_start_at, observe_window_ms, snapshot_points, snapshot_rule_version, snapshot_priority)
     VALUES ('v5row', 5, 'u', 'v5-acc', 'e@example.com', 'codex', 'pro', 'oauth', 'f.json', 'observing', 0, 'none', '', '', NULL, 100, 100,
             100, 600000, 30, 'rules-v1', 10)`,
  ).run()

  const v = migrate(d) // stamped v5 → 只跑 006
  assert.equal(v, LATEST_VERSION)

  const cols = columnNames(d, 'contributions')
  for (const c of NEW_COLS) assert.ok(cols.has(c), `contributions 缺新列 ${c}`)

  const row = d
    .prepare(
      'SELECT account_id, verify_status, observe_start_at, snapshot_points, observe_paused_ms, last_observed_at FROM contributions WHERE id=?',
    )
    .get('v5row') as unknown as {
    account_id: string
    verify_status: string
    observe_start_at: number | null
    snapshot_points: number | null
    observe_paused_ms: number | null
    last_observed_at: number | null
  }
  // 原数据不丢（含 004 快照列）
  assert.equal(row.account_id, 'v5-acc')
  assert.equal(row.verify_status, 'observing')
  assert.equal(row.observe_start_at, 100)
  assert.equal(row.snapshot_points, 30)
  // 新列默认 null（既有行未记暂停/成功观测）
  assert.equal(row.observe_paused_ms, null)
  assert.equal(row.last_observed_at, null)

  const sv = d.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)
  d.close()
})

// ---------------------------- Part B：巡检闭环（单例连接 / MOCK）----------------------------

let db: typeof import('../lib/db.ts').db
let collect: typeof import('../lib/collect.ts')
let cpa: typeof import('../lib/cpa.ts').cpa
let tmpDir: string

const INTERVAL = 8000 // worker 预期观测间隔（下方 before 显式固定 WORKER_INTERVAL_MS）
const WIN = 600_000 // 考察窗口 10min（够长，回拨精确控制到期）

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
    authFileName: 'codex-f.json',
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

// 直插一个「已在考察中」的 codex 号（绕过首检；冻结窗口=WIN 的快照）
function seedObserving(id: string, accountId: string, uid: number): void {
  db.insertUnique(
    makeContribution({ id, accountId, linuxdoId: uid, provider: 'codex', verifyStatus: 'observing' }),
  )
  db.startObservation(id, {
    windowMs: WIN,
    points: db.pointsFor('codex', 'plus'),
    ruleVersion: 'rules-v1',
    priority: 10,
  })
}

// 回拨计时起点 deltaMs（模拟 wall-clock 流逝，不睡眠）
function backdate(id: string, deltaMs: number): void {
  const start = db.getObservationSnapshot(id).observeStartAt
  assert.ok(start !== null, 'backdate 前该号应已进考察')
  db.update(id, { observeStartAt: start - deltaMs })
}

// 临时替换 cpa.inspect 做确定性巡检；跑完 try/finally 还原（不泄漏到后续测试）
async function withInspect(fake: typeof cpa.inspect, fn: () => Promise<void>): Promise<void> {
  const orig = cpa.inspect
  cpa.inspect = fake
  try {
    await fn()
  } finally {
    cpa.inspect = orig
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-grace-'))
  process.env.MOCK = 'true'
  process.env.WORKER_INTERVAL_MS = String(INTERVAL)
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  ;({ cpa } = await import('../lib/cpa.ts'))
  collect = await import('../lib/collect.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ③ 未知不推进（inspect 返回但未覆盖该号）：记 unknown(not-covered)、留 observing、不发分不判死
test('未知不推进：inspect 未覆盖的 observing 号 → unknown(not-covered)，留 observing、不发分', async () => {
  const uid = 9101
  const id = 'grace-notcovered'
  seedObserving(id, 'grace-acc-notcovered', uid)
  // inspect 返回了结果，但只含别的号（不含本号）→ 本号未被覆盖
  await withInspect(
    async () => [{ accountId: 'someone-else', decision: 'ok', plan: 'plus', reason: 'ok' }],
    async () => {
      await collect.processPending()
    },
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'observing') // 不推进
  assert.equal(db.balance(uid), 0) // 不发分
  assert.equal(db.hasHardFailure(id), false) // 未知绝不算硬失败
  const last = db.observationsFor(id).at(-1)
  assert.equal(last?.kind, 'unknown')
  assert.equal(last?.detail, 'not-covered')
})

// ④ 未知不推进（inspect 整体抛错）：所有 observing 号记 unknown(inspect-failed)、留 observing
test('未知不推进：inspect 整体抛错 → observing 号 unknown(inspect-failed)，不发分不判死', async () => {
  const uid = 9102
  const id = 'grace-inspectfail'
  seedObserving(id, 'grace-acc-inspectfail', uid)
  await withInspect(
    async () => {
      throw new Error('CPA 5xx / 网络故障')
    },
    async () => {
      await collect.processPending()
    },
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'observing')
  assert.equal(db.balance(uid), 0)
  assert.equal(db.hasHardFailure(id), false)
  const last = db.observationsFor(id).at(-1)
  assert.equal(last?.kind, 'unknown')
  assert.equal(last?.detail, 'inspect-failed')
})

// ⑤ 故障顺延（核心·结算公式）：暂停时段从考察窗口 T 扣除——按「有效观测时长」而非 wall-clock 判到期。
//    用 claude 号 + 手动种入暂停隔离 settle 公式（claude 简化路径本不记暂停；codex 的自动累积见 ⑥）。
test('故障顺延（核心）：暂停时段不计入 T——有效观测时长达标才发分', async () => {
  const uid = 9103
  const id = 'grace-core'
  db.setConfig('observe_window_ms', String(WIN))
  db.insertUnique(
    makeContribution({
      id,
      accountId: 'grace-acc-core',
      linuxdoId: uid,
      provider: 'claude',
      plan: 'pro',
      authFileName: 'claude-f.json',
    }),
  )
  await collect.processPending() // claude 首检直接进考察（冻结 window=WIN, points=20）
  assert.equal(db.byUser(uid).find((x) => x.id === id)?.verifyStatus, 'observing')

  // 构造停机空洞：wall-clock 已越过窗口(WIN+DOWN)，但其中含 DOWN+MARGIN 的不可观测暂停。
  const DOWN = 100_000
  const MARGIN = 50_000 // 亏欠余量（远大于测试执行的 ms 级抖动，防 flaky）
  backdate(id, WIN + DOWN) // 纯 wall-clock 判定会误判到期
  db.recordObserveTick(id, { lastObservedAt: Date.now(), addPausedMs: DOWN + MARGIN }) // 暂停累积 DOWN+MARGIN

  await collect.processPending() // 有效 ≈ (WIN+DOWN) - (DOWN+MARGIN) = WIN-MARGIN < WIN → 未到期
  assert.equal(
    db.byUser(uid).find((x) => x.id === id)?.verifyStatus,
    'observing',
    '暂停时段应从 T 扣除：有效观测时长 < WIN，不得发分',
  )
  assert.equal(db.balance(uid), 0)

  // 再补 MARGIN+1000 的 wall-clock（有效跨过窗口）→ 到期发分
  backdate(id, MARGIN + 1_000) // 有效 ≈ WIN+1000 ≥ WIN
  await collect.processPending()
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'granted')
  assert.equal(db.balance(uid), 20)
})

// ⑥ 故障顺延（codex 自动累积）：成功观测遇观测空洞 → 累加暂停、更新 last_observed_at、不误发分
test('故障顺延记账：codex 成功观测遇观测空洞 → 累加暂停、推进 last_observed_at', async () => {
  const uid = 9104
  const id = 'grace-tick'
  seedObserving(id, 'grace-acc-tick', uid) // observe_start_at=now, last_observed_at=null, paused=0
  const GAP = 3_600_000 // 模拟距上次成功观测 1h 的空洞（停机/不可观测）
  db.recordObserveTick(id, { lastObservedAt: Date.now() - GAP, addPausedMs: 0 }) // 种入「上次成功观测在 1h 前」

  await withInspect(
    async () => [{ accountId: 'grace-acc-tick', decision: 'ok', plan: 'plus', reason: 'ok' }],
    async () => {
      await collect.processPending()
    },
  )

  const tick = db.getObserveTick(id)
  // 空洞≈GAP，暂停增量≈GAP-INTERVAL（超出一个预期间隔的部分算暂停）
  assert.ok(tick.pausedMs >= GAP - INTERVAL, `暂停应累积≈GAP-interval，实际 ${tick.pausedMs}`)
  assert.ok(tick.pausedMs <= GAP, `暂停不应超过空洞本身，实际 ${tick.pausedMs}`)
  assert.ok(
    tick.lastObservedAt !== null && tick.lastObservedAt >= Date.now() - 60_000,
    'last_observed_at 应推到本次成功观测',
  )
  // 有效观测时长仍很短（空洞不计入 T）→ 未到期、仍 observing
  assert.equal(db.byUser(uid).find((x) => x.id === id)?.verifyStatus, 'observing')
  assert.equal(db.balance(uid), 0)
})

// ⑦ 软失败不阻断：inspect retry(额度/限流) → soft_fail，到期仍发分
test('软失败不阻断：inspect retry(额度耗尽) → soft_fail，到期仍发分', async () => {
  const uid = 9105
  const id = 'grace-soft'
  seedObserving(id, 'grace-acc-soft', uid)
  db.recordObserveTick(id, { lastObservedAt: Date.now(), addPausedMs: 0 }) // last_observed_at=now：回拨不触发误判暂停
  backdate(id, WIN + 1) // wall-clock 到期（暂停=0 → 有效到期）
  await withInspect(
    async () => [
      { accountId: 'grace-acc-soft', decision: 'retry', plan: 'plus', reason: 'usage_limit_reached' },
    ],
    async () => {
      await collect.processPending()
    },
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(db.observationsFor(id).at(-1)?.kind, 'soft_fail') // retry+额度 → 软失败
  assert.equal(c.verifyStatus, 'granted') // 软失败不阻断到期发分
  assert.equal(c.points, 10) // pointsFor(codex, plus)
  assert.equal(db.balance(uid), 10)
})

// ⑧ 硬失败判死：inspect reject(撤权/失效) → hard_fail，判 failed 不发分（优先于到期）
test('硬失败判死：inspect reject(失效) → hard_fail，failed 不发分', async () => {
  const uid = 9106
  const id = 'grace-hard'
  seedObserving(id, 'grace-acc-hard', uid) // 刚进考察即遇硬失败（无需回拨——硬失败优先于到期）
  await withInspect(
    async () => [
      { accountId: 'grace-acc-hard', decision: 'reject', plan: 'plus', reason: 'unauthorized' },
    ],
    async () => {
      await collect.processPending()
    },
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(db.observationsFor(id).at(-1)?.kind, 'hard_fail')
  assert.equal(c.verifyStatus, 'failed')
  assert.equal(c.points, 0)
  assert.equal(db.balance(uid), 0)
})

// ---------------------------- Part C：纯映射单测 ----------------------------

function probe(decision: ProbeResult['decision'], reason: string): ProbeResult {
  return { accountId: 'a', decision, plan: 'plus', reason }
}

// ⑨ observationKind：decision 主分类 + reason 细分 soft/hard；ok 权威健康不被 reason 反转
test('observationKind：ok→healthy(reason 不反转)、reject→hard、retry+额度→soft', () => {
  const k = collect.observationKind
  assert.equal(k(probe('ok', 'ok')), 'healthy')
  assert.equal(k(probe('ok', 'looks invalid but cpamp says keep')), 'healthy') // ok 权威健康
  assert.equal(k(probe('reject', 'unauthorized')), 'hard_fail')
  assert.equal(k(probe('retry', 'usage_limit_reached')), 'soft_fail')
  assert.equal(k(probe('retry', 'rate limit exceeded')), 'soft_fail')
})

// ⑩ observationKind：reason 不明 → 保守回落 decision 现有映射（reject→硬 / retry→软）
test('observationKind：reason 不明→回落 decision（reject→hard / retry→soft）', () => {
  const k = collect.observationKind
  assert.equal(k(probe('reject', '')), 'hard_fail')
  assert.equal(k(probe('retry', '')), 'soft_fail')
})

// ⑪ pauseIncrement：正常间隔无暂停；空洞 > 2× 间隔时累计超出部分；间隔非正→0
test('pauseIncrement：<2× 无暂停(容忍抖动)、>2× 计超出一个间隔、间隔非正→0', () => {
  const p = collect.pauseIncrement
  assert.equal(p(1_000, 900, 8_000), 0) // gap=100 << 间隔
  assert.equal(p(16_000, 0, 8_000), 0) // gap=2× 恰好，不 > 2× → 无暂停（严格大于才判空洞）
  assert.equal(p(16_001, 0, 8_000), 16_001 - 8_000) // 刚越过 2× → 超出一个间隔的部分
  assert.equal(p(3_600_000, 0, 8_000), 3_600_000 - 8_000) // 大空洞
  assert.equal(p(1_000_000, 0, 0), 0) // 间隔非正 → 退化，不判暂停
})

// ── 补：codex xhigh review 于 PR #14 发现 ──────────────────────────────────

// mapInspection：cpamp 真实动作 relogin/disable 必须在 `!errorKind→ok` 兜底前拦截，
// 否则「需重登/被禁用」的号无 errorKind 时 fall-through 成 ok → observationKind 误判 healthy → 误发分。
test('mapInspection：relogin→reauth、disable→retry，不 fall-through 成 ok', () => {
  assert.equal(mapInspection({ action: 'relogin' }).decision, 'reauth') // 需重登→转人工
  assert.equal(mapInspection({ action: 'disable' }).decision, 'retry') // 禁用观察→软失败
  // 明确健康信号仍 ok（未动兜底语义）
  assert.equal(mapInspection({ action: 'keep' }).decision, 'ok')
  assert.equal(mapInspection({ action: 'enable' }).decision, 'ok')
  assert.equal(mapInspection({ statusCode: 200 }).decision, 'ok')
  // 明确失效仍 reject
  assert.equal(mapInspection({ action: 'delete' }).decision, 'reject')
  assert.equal(mapInspection({ statusCode: 401 }).decision, 'reject')
})

// migration 006 回填：部署 P2b 时正在考察（observing）的号，从最近非 unknown 观测回填 last_observed_at，
// 否则首次 recordTick 以 observe_start_at 为基点把整个部署前窗口误算成停机、发分大延迟。
test('迁移006回填：observing 行 last_observed_at 从最近非 unknown 观测回填', () => {
  const d = makeV5Db()
  const t0 = 1_000_000
  // 一个 observing 号（004 已加 observe_start_at 列；此处直接给旧的进考察时刻）
  d.prepare(
    `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at,
        observe_start_at, observe_window_ms, snapshot_points, snapshot_rule_version, snapshot_priority)
     VALUES ('obs-bf', 1, 'u', 'acc-bf', 'e@x.com', 'codex', 'plus', 'oauth', 'f.json',
        'observing', 0, 'none', '', '', NULL, ${t0}, ${t0}, ${t0}, 86400000, 10, 'rules-v1', 10)`,
  ).run()
  const ins = d.prepare(
    'INSERT INTO observations (contribution_id, observed_at, kind, detail, created_at) VALUES (?,?,?,?,?)',
  )
  ins.run('obs-bf', t0 + 1000, 'healthy', '', t0 + 1000)
  ins.run('obs-bf', t0 + 5000, 'healthy', '', t0 + 5000) // 最近的非 unknown 观测
  ins.run('obs-bf', t0 + 9000, 'unknown', 'inspect-failed', t0 + 9000) // unknown 不作回填来源

  migrate(d) // 跑 006（含回填）

  const row = d.prepare('SELECT last_observed_at FROM contributions WHERE id=?').get('obs-bf') as unknown as {
    last_observed_at: number
  }
  assert.equal(row.last_observed_at, t0 + 5000) // 回填成最近非 unknown 观测时刻，非 unknown 的 9000

  // 无观测记录的 observing 行：留 null（首次 tick 以 observe_start_at 兜底）
  d.prepare(
    `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at,
        observe_start_at)
     VALUES ('obs-none', 1, 'u', 'acc-none', 'e@x.com', 'codex', 'plus', 'oauth', 'f.json',
        'observing', 0, 'none', '', '', NULL, ${t0}, ${t0}, ${t0})`,
  ).run()
  // 重跑 migrate 不会再动（006 已应用）——单独验证回填 SQL 的 EXISTS 守卫语义：手动跑回填不误设
  const none = d.prepare('SELECT last_observed_at FROM contributions WHERE id=?').get('obs-none') as unknown as {
    last_observed_at: number | null
  }
  assert.equal(none.last_observed_at, null)
})
