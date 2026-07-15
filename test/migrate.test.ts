import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../lib/migrate.ts'

const EXPECTED_TABLES = [
  'contributions',
  'app_config',
  'point_rules',
  'redeem_items',
  'point_ledger',
  'redemptions',
]

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

// ① 空库跑 migrate → 所有表存在 + schema_version.version = 1
test('空库跑 migrate：建全部表且版本=1', () => {
  const db = new DatabaseSync(':memory:')
  const version = migrate(db)
  assert.equal(version, 1)
  const names = tableNames(db)
  for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `缺表 ${t}`)
  const row = db.prepare('SELECT version FROM schema_version').get() as unknown as {
    version: number
  }
  assert.equal(row.version, 1)
  db.close()
})

// ② 已有表、无 schema_version 的旧库 → 认定 baseline(version=1)、原有数据不丢、不报错
test('旧库（有 contributions 无 schema_version）：认定 baseline 且不丢数据', () => {
  const db = new DatabaseSync(':memory:')
  // 模拟迁移框架之前的旧库：手动建 contributions 并写入一行
  db.exec('CREATE TABLE contributions (id TEXT PRIMARY KEY, account_id TEXT)')
  db.prepare('INSERT INTO contributions (id, account_id) VALUES (?, ?)').run('c1', 'acc-1')
  const version = migrate(db)
  assert.equal(version, 1) // 认定 baseline 已应用，不重跑 001
  // 原有数据仍在
  const row = db.prepare('SELECT account_id FROM contributions WHERE id = ?').get('c1') as unknown as {
    account_id: string
  }
  assert.equal(row.account_id, 'acc-1')
  // schema_version 建好且=1
  const sv = db.prepare('SELECT version FROM schema_version').get() as unknown as { version: number }
  assert.equal(sv.version, 1)
  db.close()
})

// ③ migrate 重复调用幂等：第二次不重跑、version 不变、schema_version 仍单行
test('migrate 幂等：重复调用版本不变且不重跑', () => {
  const db = new DatabaseSync(':memory:')
  const v1 = migrate(db)
  const v2 = migrate(db)
  assert.equal(v1, 1)
  assert.equal(v2, 1)
  const rows = db.prepare('SELECT version FROM schema_version').all() as unknown as {
    version: number
  }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].version, 1)
  db.close()
})
