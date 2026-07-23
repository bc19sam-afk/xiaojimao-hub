import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, LATEST_VERSION } from '../lib/migrate.ts'

// ============================================================================
// 「schema_version 有表无行」迁移假成功回归（codex xhigh 于 PR #29 复审发现）：
// 某次初始化恰在 CREATE TABLE schema_version 与插入初始行之间被打断的遗留库——表存在但无行。
// startingVersion 见表存在即读 row?.version ?? 0 = 0，不补插初始行（那条 INSERT ... WHERE NOT
// EXISTS 只在建表分支跑，见表存在的分支不跑）。migrate 主循环每步跑 up() 后
// `UPDATE schema_version SET version=?` 影响 0 行——迁移全跑了、版本却永不落库，migrate() 却返回
// 内存里的 version 值让调用方以为成功。下次再跑：版本仍读 0，迁移重放，migration 004/006 之类
// 非幂等的 ALTER TABLE ADD COLUMN 直接炸 duplicate column。
// ============================================================================

// 构造「有表无行」库：CREATE TABLE schema_version 的 DDL 与 lib/migrate.ts startingVersion
// 建表处一字不差，但绝不插初始行。
function makeEmptyVersion(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
}

test('有表无行库跑 migrate()：版本持久化=LATEST（修复前此断言红）', () => {
  const db = new DatabaseSync(':memory:')
  makeEmptyVersion(db)
  // 前置确认确实是「有表无行」
  const pre = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as unknown as {
    n: number
  }
  assert.equal(pre.n, 0, '前置：schema_version 应存在但无行')

  const version = migrate(db)
  assert.equal(version, LATEST_VERSION) // 返回值应为最新版

  // 关键断言：版本必须真落库（修复前 UPDATE 影响 0 行 → 表仍无行、读出 undefined）
  const rows = db.prepare('SELECT version FROM schema_version').all() as unknown as {
    version: number
  }[]
  assert.equal(rows.length, 1, '版本应持久化为单行')
  assert.equal(rows[0].version, LATEST_VERSION, '持久化版本应=LATEST')
  db.close()
})

test('有表无行库跑第二次 migrate() 幂等无错（修复前会炸 duplicate column）', () => {
  const db = new DatabaseSync(':memory:')
  makeEmptyVersion(db)

  const v1 = migrate(db)
  assert.equal(v1, LATEST_VERSION)
  // 第二次调用应幂等：版本已落库 → 跳过所有迁移，不重放非幂等 ALTER
  const v2 = migrate(db)
  assert.equal(v2, LATEST_VERSION)

  const rows = db.prepare('SELECT version FROM schema_version').all() as unknown as {
    version: number
  }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].version, LATEST_VERSION)
  db.close()
})

test('已有最新 schema 但版本行为空：拒绝重放且不改业务数据', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  db.prepare(
    `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code,
        created_at, updated_at, pooled_at, snapshot_rule_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'already-migrated',
    1,
    'tester',
    'acc-existing',
    'tester@example.com',
    'codex',
    'plus',
    'oauth',
    'codex-existing.json',
    'pooled',
    0,
    'none',
    '',
    '',
    null,
    100,
    100,
    999,
    'rule-v9',
  )
  db.exec('DELETE FROM schema_version')

  let error = ''
  try {
    migrate(db)
  } catch (err) {
    error = (err as Error).message
  }

  const row = db
    .prepare('SELECT pooled_at, snapshot_rule_version FROM contributions WHERE id=?')
    .get('already-migrated') as unknown as {
    pooled_at: number | null
    snapshot_rule_version: string | null
  }
  assert.deepEqual({ ...row }, { pooled_at: 999, snapshot_rule_version: 'rule-v9' })
  const versions = db.prepare('SELECT version FROM schema_version').all()
  assert.equal(versions.length, 0, '拒绝时不得猜测或回填版本')
  assert.match(error, /已有业务表.*拒绝自动重放/)
  db.close()
})
