import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'
import type { SessionUser } from '../lib/session.ts'

// ============================================================================
// P2a-2：考察期最小闭环。两部分：
//   Part A —— migration 005（破坏性）：verify_status 旧 7 态 → 新 6 态映射、行数不丢、版本到最新。
//             直接驱动 migrate/up，用内存库。
//   Part B —— 考察闭环（走 lib/collect.ts processPending，MOCK 模式、单例连接）：首检过→observing、
//             冻结快照、未到期保持、到期无硬失败→granted+发分（用 snapshotPoints）、硬失败→failed 不发分、
//             §3.4 冻结（改配后按快照结算）、发分幂等。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指向临时目录再动态 import；绝不碰真实 data/。
//   为不依赖 mock inspect 的哈希随机，Part B 主用 claude 号（首检直接进考察、考察期直接 healthy），
//   到期与否用「回拨 observe_start_at」精确控制、不睡眠；codex 分支另做 smoke（走真实 mock OAuth）。
// ============================================================================

// ---------------------------- Part A：migration 005（内存库）----------------------------

// 建到 v4 的内存库（跑 migrations 1..4 的 up + stamp schema_version=4）
function makeV4Db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const m of migrations.filter((m) => m.version <= 4).sort((a, b) => a.version - b.version)) {
    m.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (4)').run()
  return d
}

const INSERT_17 = `INSERT INTO contributions
   (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
    verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
   VALUES (?, ?, 'u', ?, 'e@example.com', 'codex', 'plus', 'oauth', 'f.json', ?, 0, 'none', '', '', NULL, 100, 100)`

// ① 迁移 005：旧 7 态逐一映射到新 6 态、行数不丢、版本到最新（含 005）
test('迁移005：旧 7 态→新 6 态映射正确、行数不丢、版本到最新', () => {
  assert.ok(migrations.some((m) => m.version === 5), '应存在 migration 005')
  const d = makeV4Db()
  const mapping: Record<string, string> = {
    pending: 'submitted',
    verifying: 'first_check',
    active: 'granted',
    rejected: 'failed',
    quarantined: 'first_check', // 重走首检记快照，避免无快照的 observing 卡死（codex xhigh review）
    reauth: 'needs_review',
    duplicate: 'failed',
  }
  const olds = Object.keys(mapping)
  const ins = d.prepare(INSERT_17)
  olds.forEach((s, i) => ins.run(`r${i}`, i + 1, `acc-${i}`, s))
  const before = (d.prepare('SELECT COUNT(*) AS n FROM contributions').get() as { n: number }).n

  const v = migrate(d) // stamped v4 → 只跑 005
  assert.equal(v, LATEST_VERSION)

  // 逐一校验映射
  olds.forEach((s, i) => {
    const row = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get(`r${i}`) as {
      verify_status: string
    }
    assert.equal(row.verify_status, mapping[s], `${s} 应迁为 ${mapping[s]}`)
  })
  // 行数不丢
  const after = (d.prepare('SELECT COUNT(*) AS n FROM contributions').get() as { n: number }).n
  assert.equal(after, before)
  assert.equal(after, olds.length)
  // schema_version 单行 = 最新
  const sv = d.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)
  d.close()
})

// ② 迁移 005 空库无害：无数据时纯 no-op（行数 0、版本到最新）
test('迁移005：空库上纯 no-op，版本仍到最新', () => {
  const d = new DatabaseSync(':memory:')
  const v = migrate(d) // 空库跑满全链（含 005）
  assert.equal(v, LATEST_VERSION)
  const n = (d.prepare('SELECT COUNT(*) AS n FROM contributions').get() as { n: number }).n
  assert.equal(n, 0)
  d.close()
})

// ---------------------------- Part B：考察闭环（单例连接 / MOCK）----------------------------

let db: typeof import('../lib/db.ts').db
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
    provider: 'claude',
    plan: 'pro',
    method: 'oauth',
    authFileName: 'claude-f.json',
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

function user(id: number): SessionUser {
  return { id, username: `u${id}`, trustLevel: 3 }
}

// 把一个在考察中的号「回拨计时起点」deltaMs 毫秒（模拟时间流逝，不睡眠）。
function backdate(id: string, deltaMs: number): void {
  const start = db.getObservationSnapshot(id).observeStartAt
  assert.ok(start !== null, 'backdate 前该号应已进考察')
  db.update(id, { observeStartAt: start - deltaMs })
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-obsloop-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  collect = await import('../lib/collect.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const WIN = 600_000 // 测试用考察窗口 10min（够长，回拨精确控制到期与否）

// ③ 首检通过 → 考察中，且 §3.4 冻结五字段快照（窗口/分值/规则版本/优先级 + 计时起点）
test('首检通过→考察中：启用并冻结快照（窗口=当时T、分值=pointsFor、规则=rules-v1、优先级=10）', async () => {
  const uid = 7001
  const id = 'loop-enter'
  db.setConfig('observe_window_ms', String(WIN)) // 进考察时冻结此 T
  db.insertUnique(makeContribution({ id, accountId: 'loop-acc-enter', linuxdoId: uid }))

  await collect.processPending() // 首检（claude 直接通过）→ 进考察

  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'observing')
  const snap = db.getObservationSnapshot(id)
  assert.ok(snap.observeStartAt !== null) // 计时起点已记
  assert.equal(snap.observeWindowMs, WIN) // 冻结当时的 T
  assert.equal(snap.snapshotPoints, 20) // pointsFor('claude','*')=20（seed 规则）
  assert.equal(snap.snapshotRuleVersion, 'rules-v1')
  assert.equal(snap.snapshotPriority, 10)
  assert.equal(db.balance(uid), 0) // 未到期，尚未发分
})

// ④ 考察闭环全序：未到期保持 observing → 到期无硬失败 → granted + 发分（用 snapshotPoints）
test('考察闭环：未到期保持 observing；到期无硬失败→granted 且发 snapshotPoints', async () => {
  const uid = 7002
  const id = 'loop-mature'
  db.setConfig('observe_window_ms', String(WIN))
  db.insertUnique(makeContribution({ id, accountId: 'loop-acc-mature', linuxdoId: uid }))

  await collect.processPending() // 首检→observing
  assert.equal(db.byUser(uid).find((x) => x.id === id)?.verifyStatus, 'observing')

  // 未到期：再跑一轮仍保持 observing、不发分
  await collect.processPending()
  assert.equal(db.byUser(uid).find((x) => x.id === id)?.verifyStatus, 'observing')
  assert.equal(db.balance(uid), 0)

  // 到期（回拨计时起点越过窗口）：下一轮无硬失败 → 发分 + granted
  backdate(id, WIN + 1)
  await collect.processPending()
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'granted')
  assert.equal(c.points, 20) // 冻结的 snapshotPoints
  assert.equal(c.rewardStatus, 'granted')
  assert.equal(db.balance(uid), 20)
})

// ⑤ 考察期出现硬失败 → 判死 failed、不发分（即便未到期也立即判死）
test('考察期 hard_fail → failed 不发分（硬失败优先于到期判定）', async () => {
  const uid = 7003
  const id = 'loop-hardfail'
  db.setConfig('observe_window_ms', String(WIN))
  db.insertUnique(makeContribution({ id, accountId: 'loop-acc-hardfail', linuxdoId: uid }))

  await collect.processPending() // → observing
  assert.equal(db.byUser(uid).find((x) => x.id === id)?.verifyStatus, 'observing')

  db.addObservation(id, 'hard_fail', 'test-ban') // 窗口内出现硬失败
  await collect.processPending() // settle 见硬失败 → failed（不发分）

  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'failed')
  assert.equal(c.points, 0)
  assert.equal(db.balance(uid), 0)
})

// ⑥ §3.4 冻结：进考察后改后台配置（窗口 T + 发分规则），在考察的号仍按进考察那刻的快照结算
test('§3.4 冻结：改 T 与分值规则后，在考察号仍按快照的窗口与分值结算（不受后台改配影响）', async () => {
  const uid = 7004
  const id = 'loop-freeze'
  db.setConfig('observe_window_ms', String(WIN)) // 进考察冻结窗口=WIN、分值=20
  db.insertUnique(makeContribution({ id, accountId: 'loop-acc-freeze', linuxdoId: uid }))
  await collect.processPending() // → observing（冻结 window=WIN, points=20）

  // 后台此后改配：窗口缩到 1ms、claude 分值规则抬到 999
  db.setConfig('observe_window_ms', '1')
  db.upsertPointRule({ provider: 'claude', plan: '*', points: 999, enabled: true, label: 'bump' })
  assert.equal(db.pointsFor('claude', 'pro'), 999) // 规则确实已改（若结算重查规则会拿到 999）

  // (a) 证明用「冻结窗口」判到期：回拨 5s（< 冻结 WIN，但 >> 新配 1ms）→ 仍未到期、保持 observing
  backdate(id, 5_000)
  await collect.processPending()
  assert.equal(
    db.byUser(uid).find((x) => x.id === id)?.verifyStatus,
    'observing',
    '应按冻结窗口(WIN)判未到期；若误用新配(1ms)会被判到期而发分',
  )
  assert.equal(db.balance(uid), 0)

  // (b) 回拨越过冻结窗口 → 到期发分，且发的是「冻结分值 20」而非改后规则 999
  backdate(id, WIN + 1)
  await collect.processPending()
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'granted')
  assert.equal(c.points, 20) // 冻结 snapshotPoints，不受规则改动影响
  assert.equal(db.balance(uid), 20)

  // 清理：把本测试对全局 claude 规则的改动还原为 seed 值 20，避免泄漏到后续测试
  db.upsertPointRule({ provider: 'claude', plan: '*', points: 20, enabled: true, label: 'Claude' })
})

// ⑦ 发分幂等：到期发分后多轮 processPending 不重复发分（号已 granted 出考察集 + awardPoints 幂等）
test('发分幂等：granted 后多轮 processPending 余额与积分岿然不动', async () => {
  const uid = 7005
  const id = 'loop-idem'
  db.setConfig('observe_window_ms', String(WIN))
  db.insertUnique(makeContribution({ id, accountId: 'loop-acc-idem', linuxdoId: uid }))
  await collect.processPending() // → observing
  backdate(id, WIN + 1)
  await collect.processPending() // → granted + 发 20
  assert.equal(db.balance(uid), 20)

  // 再多跑几轮：不重复发分
  await collect.processPending()
  await collect.processPending()
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'granted')
  assert.equal(c.points, 20)
  assert.equal(db.balance(uid), 20) // 只发一次
})

// ⑧ codex 首检走 cpamp inspect 分支（smoke）：真实 mock OAuth 造号 → processPending 后不再停留 submitted
// （不依赖 mock inspect 的随机 decision：只断言首检确实执行、号离开 submitted 到某个合法后继态）
test('codex 首检 smoke：mock OAuth 造号 → processPending 后离开 submitted（走 inspect 分支）', async () => {
  const uid = 7006
  const start = await collect.startOAuth('codex')
  const r = await collect.finishOAuth(user(uid), 'codex', `https://app/cb?state=${start.state}`)
  if (!r.ok) assert.fail(`mock finishOAuth 应成功：${r.error}`)
  const id = r.contribution.id
  assert.equal(db.byUser(uid).find((x) => x.id === id)?.verifyStatus, 'submitted') // 落号即已提交

  await collect.processPending() // codex 分支：inspect 覆盖该号 → 首检
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.notEqual(c.verifyStatus, 'submitted') // 首检确已执行
  assert.ok(
    ['observing', 'failed', 'needs_review', 'first_check'].includes(c.verifyStatus),
    `首检后应落在合法后继态，实际 ${c.verifyStatus}`,
  )
})
