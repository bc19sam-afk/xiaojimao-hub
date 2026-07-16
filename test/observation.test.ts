import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'

// ============================================================================
// P2a-1：考察闭环数据地基（纯新增、零破坏）。两部分：
//   Part A —— migration 004 结构：空库 / v3 旧库 跑迁移后，observations 表在、contributions
//             加齐 5 个快照列、原数据不丢、版本到最新。直接驱动 migrate/up，用内存库。
//   Part B —— db.ts 数据层 API 往返：观测事件 addObservation/observationsFor/hasHardFailure、
//             考察快照 startObservation/getObservationSnapshot。走单例连接（红线：临时库隔离）。
// 本单只建数据层，暂无写入方（P2b/P2c 巡检时才调）；此处测试直接驱动 db API 验证。
// ============================================================================

const SNAPSHOT_COLS = [
  'observe_start_at',
  'observe_window_ms',
  'snapshot_points',
  'snapshot_rule_version',
  'snapshot_priority',
]

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}
function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

// ---- Part B 用：单例连接需先把 DB_PATH 指向临时目录再动态 import（绝不碰真实开发库）----
let db: typeof import('../lib/db.ts').db
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
    verifyStatus: 'pending',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-obs-'))
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  ;({ db } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ============================ Part A：migration 004 结构 ============================

// ① 空库 migrate → 最新版；observations 表在、contributions 有 5 个快照列
test('迁移004：空库 migrate→最新，observations 表在、contributions 加齐 5 个快照列', () => {
  const d = new DatabaseSync(':memory:')
  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)
  assert.ok(migrations.some((m) => m.version === 4), '应存在 migration 004')

  assert.ok(hasTable(d, 'observations'), '缺 observations 表')
  const obsCols = columnNames(d, 'observations')
  for (const c of ['id', 'contribution_id', 'observed_at', 'kind', 'detail', 'created_at']) {
    assert.ok(obsCols.has(c), `observations 缺列 ${c}`)
  }

  const cols = columnNames(d, 'contributions')
  for (const c of SNAPSHOT_COLS) assert.ok(cols.has(c), `contributions 缺快照列 ${c}`)
  d.close()
})

// ② v3 旧库（有数据）migrate → 加表加列、原 contributions 数据不丢、新列默认 null、version=最新
test('迁移004：v3 旧库（有数据）migrate→最新，加表加列、原数据不丢、新列为 null', () => {
  const d = new DatabaseSync(':memory:')
  // 造 v3 状态：按序跑 migration 1..3 的 up()，再手工 stamp schema_version=3
  for (const m of migrations.filter((m) => m.version <= 3).sort((a, b) => a.version - b.version)) {
    m.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (3)').run()
  // v3 的 contributions（post-002 复合唯一键、尚无快照列）塞一行
  d.prepare(
    `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
     VALUES ('v3row', 5, 'u', 'v3-acc', 'e@example.com', 'codex', 'pro', 'oauth', 'f.json', 'active', 30, 'granted', '', '', NULL, 100, 100)`,
  ).run()

  const v = migrate(d) // 只应跑 004（schema_version=3）
  assert.equal(v, LATEST_VERSION)

  // 加表加列
  assert.ok(hasTable(d, 'observations'), '缺 observations 表')
  const cols = columnNames(d, 'contributions')
  for (const c of SNAPSHOT_COLS) assert.ok(cols.has(c), `contributions 缺快照列 ${c}`)

  // 原数据不丢 + 新列默认 null（既有行未进考察）
  const row = d
    .prepare(
      'SELECT account_id, points, observe_start_at, observe_window_ms, snapshot_points, snapshot_rule_version, snapshot_priority FROM contributions WHERE id=?',
    )
    .get('v3row') as unknown as {
    account_id: string
    points: number
    observe_start_at: number | null
    observe_window_ms: number | null
    snapshot_points: number | null
    snapshot_rule_version: string | null
    snapshot_priority: number | null
  }
  assert.equal(row.account_id, 'v3-acc')
  assert.equal(row.points, 30)
  assert.equal(row.observe_start_at, null)
  assert.equal(row.observe_window_ms, null)
  assert.equal(row.snapshot_points, null)
  assert.equal(row.snapshot_rule_version, null)
  assert.equal(row.snapshot_priority, null)

  // schema_version 单行 = 最新（此刻 LATEST_VERSION === 4）
  const sv = d.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)
  d.close()
})

// ============================ Part B：db.ts 数据层 API 往返 ============================

// ③ 观测事件往返：addObservation 多条 → observationsFor 按 observed_at 升序取回
test('观测往返：addObservation 多条 → observationsFor 按序取回（插入序＝取回序）', () => {
  db.insertUnique(makeContribution({ id: 'obs-1', accountId: 'obs-acc-1', linuxdoId: 8001 }))
  db.addObservation('obs-1', 'healthy', 'first')
  db.addObservation('obs-1', 'soft_fail', 'blip')
  db.addObservation('obs-1', 'healthy', 'again')

  const obs = db.observationsFor('obs-1')
  assert.equal(obs.length, 3)
  assert.deepEqual(
    obs.map((o) => o.detail),
    ['first', 'blip', 'again'],
  )
  assert.deepEqual(
    obs.map((o) => o.kind),
    ['healthy', 'soft_fail', 'healthy'],
  )
  assert.equal(obs[0].contributionId, 'obs-1')
  assert.ok(obs.every((o) => typeof o.observedAt === 'number' && typeof o.createdAt === 'number'))
  // 不串号：未知号取回空
  assert.equal(db.observationsFor('nonexistent').length, 0)
})

// ④ hasHardFailure：无 hard_fail → false；出现 hard_fail → true（soft_fail 不算）
test('hasHardFailure：无硬失败→false，出现 hard_fail→true（soft_fail 不算）', () => {
  db.insertUnique(makeContribution({ id: 'obs-2', accountId: 'obs-acc-2', linuxdoId: 8002 }))
  db.addObservation('obs-2', 'healthy')
  db.addObservation('obs-2', 'soft_fail', 'transient')
  assert.equal(db.hasHardFailure('obs-2'), false)
  db.addObservation('obs-2', 'hard_fail', 'banned')
  assert.equal(db.hasHardFailure('obs-2'), true)
})

// ⑤ 考察快照往返：startObservation 冻结五字段 → getObservationSnapshot 读回一致；toContribution 侧亦映射
test('考察快照：startObservation 冻结五字段 → getObservationSnapshot 读回一致', () => {
  db.insertUnique(makeContribution({ id: 'snap-1', accountId: 'snap-acc-1', linuxdoId: 8003 }))
  // 进考察前：五字段皆 null
  assert.deepEqual(db.getObservationSnapshot('snap-1'), {
    observeStartAt: null,
    observeWindowMs: null,
    snapshotPoints: null,
    snapshotRuleVersion: null,
    snapshotPriority: null,
  })

  const t0 = Date.now()
  db.startObservation('snap-1', {
    windowMs: 86_400_000,
    points: 30,
    ruleVersion: 'rules-v1',
    priority: 7,
  })

  const snap = db.getObservationSnapshot('snap-1')
  assert.ok(snap.observeStartAt !== null && snap.observeStartAt >= t0) // 计时起点已记
  assert.equal(snap.observeWindowMs, 86_400_000)
  assert.equal(snap.snapshotPoints, 30)
  assert.equal(snap.snapshotRuleVersion, 'rules-v1')
  assert.equal(snap.snapshotPriority, 7)

  // toContribution 侧映射到可选字段
  const c = db.byUser(8003).find((x) => x.id === 'snap-1')
  assert.ok(c)
  assert.equal(c.observeWindowMs, 86_400_000)
  assert.equal(c.snapshotPoints, 30)
  assert.equal(c.snapshotRuleVersion, 'rules-v1')
  assert.equal(c.snapshotPriority, 7)
  assert.equal(typeof c.observeStartAt, 'number')
})

// ⑥ 未进考察的号：getObservationSnapshot.observeStartAt 为 null，toContribution 侧为 undefined
test('未进考察：observeStartAt 为 null；toContribution 侧对应字段为 undefined', () => {
  db.insertUnique(makeContribution({ id: 'snap-2', accountId: 'snap-acc-2', linuxdoId: 8004 }))
  assert.equal(db.getObservationSnapshot('snap-2').observeStartAt, null)
  const c = db.byUser(8004).find((x) => x.id === 'snap-2')
  assert.ok(c)
  assert.equal(c.observeStartAt, undefined) // 列 null→undefined
  assert.equal(c.snapshotPoints, undefined)
  assert.equal(c.snapshotRuleVersion, undefined)
})

// ⑦ 快照 0 值保真：points=0 / priority=0 不被吞成 null/undefined（?? 只吞 null，不吞 0）
test('快照 0 值保真：points=0 / priority=0 读回仍是 0（?? 不吞 0）', () => {
  db.insertUnique(makeContribution({ id: 'snap-3', accountId: 'snap-acc-3', linuxdoId: 8005 }))
  db.startObservation('snap-3', { windowMs: 1000, points: 0, ruleVersion: 'r0', priority: 0 })
  const snap = db.getObservationSnapshot('snap-3')
  assert.equal(snap.snapshotPoints, 0)
  assert.equal(snap.snapshotPriority, 0)
  const c = db.byUser(8005).find((x) => x.id === 'snap-3')
  assert.ok(c)
  assert.equal(c.snapshotPoints, 0)
  assert.equal(c.snapshotPriority, 0)
})

// ⑧ 快照冻结契约（§3.4）：startObservation 是 compare-and-set——首次成功、二次拒绝且快照岿然不动
//    （worker 重试/重入不得重启计时窗口、不得用后台改后的配置污染在考察的号）
test('快照冻结：startObservation 首次成功、二次返回 false 且不重写（§3.4 冻结契约）', async () => {
  db.insertUnique(makeContribution({ id: 'freeze-1', accountId: 'freeze-acc-1', linuxdoId: 8006 }))

  const first = db.startObservation('freeze-1', { windowMs: 86_400_000, points: 30, ruleVersion: 'rules-v1', priority: 7 })
  assert.equal(first, true) // 首次初始化成功
  const snap1 = db.getObservationSnapshot('freeze-1')

  await new Promise((r) => setTimeout(r, 5)) // 拉开时间，若二次重写 observe_start_at 会变
  // 二次进考察（模拟 worker 重入 + 后台此间改了配置）：必须被拒、快照一字不改
  const second = db.startObservation('freeze-1', { windowMs: 999, points: 999, ruleVersion: 'rules-v2', priority: 1 })
  assert.equal(second, false) // CAS 拒绝
  assert.deepEqual(db.getObservationSnapshot('freeze-1'), snap1) // 计时起点/窗口/分值/规则/优先级全冻结不变
})

// ⑨ addObservation kind fail-closed：非法 kind 抛错，绝不落库（防 'hard-fail' 之类被 hasHardFailure 漏判）
test('观测类型校验：非法 kind 抛错且不落库', () => {
  db.insertUnique(makeContribution({ id: 'kind-1', accountId: 'kind-acc-1', linuxdoId: 8007 }))
  // @ts-expect-error 故意传非法 kind（编译期已挡，运行时须再 fail-closed）
  assert.throws(() => db.addObservation('kind-1', 'hard-fail', 'typo'), /非法观测类型/)
  assert.equal(db.observationsFor('kind-1').length, 0) // 没落库
  // 合法 kind 正常落库
  db.addObservation('kind-1', 'hard_fail', 'real')
  assert.equal(db.hasHardFailure('kind-1'), true)
})
