import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'

// ============================================================================
// P1a：contributions 唯一键 account_id → 复合 UNIQUE(provider, account_id)。
// ①③④ 直接用内存库跑迁移机制；② 走 lib/db.ts 单例的 insertUnique（覆盖 db.ts 冲突目标改动）。
// ============================================================================

// ② 用：单例连接需先把 DB_PATH 指向临时目录再动态 import（红线：绝不碰真实开发库）。
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

// 用真实 baseline 001 建一个 version=1 的库（不复制建表 SQL）
function makeV1Db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  const baseline = migrations.find((m) => m.version === 1)
  assert.ok(baseline, 'baseline 001 应存在')
  baseline.up(d)
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (1)').run()
  return d
}

const INSERT_SQL = `INSERT INTO contributions
   (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
    verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
   VALUES (?, ?, 'u', ?, 'e@example.com', ?, 'plus', 'oauth', 'f.json', 'pending', 0, 'none', '', '', NULL, 100, 100)`

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ck-'))
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  ;({ db } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ① 升级路径：v1 有数据 → migrate 到最新，contributions 行数与内容逐行不变（002 重建不丢数据）
// （P1b-4 加了 migration 003 后 migrate 直达 v3；003 只加 oauth_snapshots 表、不碰 contributions）
test('升级路径：v1 数据 migrate 到最新后 contributions 行数与内容不变', () => {
  const d = makeV1Db()
  // v1 的 account_id 是全局 UNIQUE，故各行 account_id 互不相同；覆盖三 provider
  const seed: [string, number, string, string][] = [
    ['u1', 1001, 'acc-1', 'codex'],
    ['u2', 1002, 'acc-2', 'claude'],
    ['u3', 1003, 'acc-3', 'grok'],
  ]
  const ins = d.prepare(INSERT_SQL)
  for (const [id, uid, acc, prov] of seed) ins.run(id, uid, acc, prov)

  const beforeRows = d.prepare('SELECT * FROM contributions ORDER BY id').all()

  const version = migrate(d)
  assert.equal(version, LATEST_VERSION) // 跑满迁移链到最新（含 002 复合唯一键、003 加表、004 加快照列）
  assert.ok(LATEST_VERSION >= 2) // 002（复合唯一键）仍在链上

  const afterRows = d.prepare('SELECT * FROM contributions ORDER BY id').all() as Record<
    string,
    unknown
  >[]
  assert.equal(afterRows.length, beforeRows.length) // 行数不变
  // migration 004 给 contributions 追加了 5 个可空快照列（ALTER ADD COLUMN，向后兼容）：既有行数据
  // 一字未改、只是 SELECT * 列形状多出几列 null。故按「迁移前的列集」把两侧都归一为普通对象再逐行比
  // 对——证明原有数据逐行不变，且对未来任何「加可空列」的迁移都稳健（不写死列名）。
  // （node:sqlite 行对象是 null 原型，两侧须走同一 Object.fromEntries 归一，否则 deepStrictEqual 先
  //   比原型即失败。）
  const beforeCols = Object.keys(beforeRows[0] as Record<string, unknown>)
  const project = (rows: Record<string, unknown>[]) =>
    rows.map((r) => Object.fromEntries(beforeCols.map((k) => [k, r[k]])))
  assert.deepEqual(project(afterRows), project(beforeRows as Record<string, unknown>[])) // 原有列逐行不变
  d.close()
})

// ② 新约束语义（走 insertUnique）：同 account_id 不同 provider 都插入；同 provider 同 account_id 判重
test('新约束语义：跨 provider 同 account_id 不判重；同 provider 同 account_id 判重', () => {
  const acc = 'shared-acc'
  const c1 = db.insertUnique(makeContribution({ id: 'p2-codex', accountId: acc, provider: 'codex', linuxdoId: 2001 }))
  const c2 = db.insertUnique(makeContribution({ id: 'p2-claude', accountId: acc, provider: 'claude', linuxdoId: 2001 }))
  const c3 = db.insertUnique(makeContribution({ id: 'p2-grok', accountId: acc, provider: 'grok', linuxdoId: 2001 }))
  assert.equal(c1.duplicate, false)
  assert.equal(c2.duplicate, false) // 不同 provider，同 id → 不算重复
  assert.equal(c3.duplicate, false)

  const dup = db.insertUnique(makeContribution({ id: 'p2-codex-2', accountId: acc, provider: 'codex', linuxdoId: 2001 }))
  assert.equal(dup.duplicate, true) // 同 provider + 同 account_id → 判重

  const mine = db.byUser(2001).filter((c) => c.accountId === acc)
  assert.equal(mine.length, 3) // codex/claude/grok 各一行
})

// ③ 重复数据守卫：v1 库存在重复 (provider, account_id) → migrate 抛错且事务回滚
test('重复数据守卫：存在重复 (provider, account_id) 时 migrate 抛错并回滚，版本仍=1', () => {
  const d = new DatabaseSync(':memory:')
  // 真实 v1 的 account_id 全局 UNIQUE，正常不可能有重复对；这里手建一张「无 account_id 唯一约束」
  // 的 contributions（模拟异常/损坏库）以触发守卫。列结构与 baseline 一致，仅去掉 account_id UNIQUE。
  d.exec(`
    CREATE TABLE contributions (
      id TEXT PRIMARY KEY, linuxdo_id INTEGER NOT NULL, username TEXT NOT NULL,
      account_id TEXT NOT NULL, email TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'codex',
      plan TEXT NOT NULL, method TEXT NOT NULL, auth_file_name TEXT NOT NULL,
      verify_status TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, reward_status TEXT NOT NULL,
      reward_text TEXT NOT NULL DEFAULT '', reward_note TEXT NOT NULL DEFAULT '', reward_code TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  const ins = d.prepare(INSERT_SQL)
  ins.run('dup-a', 1, 'same-acc', 'codex')
  ins.run('dup-b', 1, 'same-acc', 'codex') // 同 (provider=codex, account_id=same-acc)
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (1)').run()

  assert.throws(() => migrate(d), /存在重复的/)

  // 回滚后：数据与版本完好，未残留 contributions_new
  const count = (d.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }).n
  assert.equal(count, 2)
  const ver = (d.prepare('SELECT version FROM schema_version').get() as unknown as { version: number }).version
  assert.equal(ver, 1)
  const leftover = d
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contributions_new'")
    .get()
  assert.equal(leftover, undefined)
  d.close()
})

// ④ 全新空库：migrate 到最新，contributions 表上唯一约束为复合键（002 生效，003 不影响）
test('全新空库：migrate 到最新且唯一约束是复合键 (provider, account_id)', () => {
  const d = new DatabaseSync(':memory:')
  const version = migrate(d)
  assert.equal(version, LATEST_VERSION)

  const ddl = (
    d
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contributions'")
      .get() as unknown as { sql: string }
  ).sql
  assert.match(ddl, /UNIQUE\s*\(\s*provider\s*,\s*account_id\s*\)/i) // 复合唯一存在
  assert.doesNotMatch(ddl, /account_id\s+TEXT[^,]*UNIQUE/i) // account_id 不再列级 UNIQUE

  // 行为验证：同 account_id 不同 provider 都插入；同对第二行触发约束
  const ins = d.prepare(INSERT_SQL)
  ins.run('f-codex', 1, 'x-acc', 'codex')
  ins.run('f-claude', 1, 'x-acc', 'claude') // 不同 provider，同 account_id → 允许
  assert.throws(() => ins.run('f-codex-2', 1, 'x-acc', 'codex'), /UNIQUE|constraint/i)

  const n = (d.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }).n
  assert.equal(n, 2)
  d.close()
})
