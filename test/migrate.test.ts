import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'

const EXPECTED_TABLES = [
  'contributions',
  'app_config',
  'point_rules',
  'redeem_items',
  'point_ledger',
  'redemptions',
  'rejections',
  'cdk_codes',
]

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

// ① 空库跑 migrate → 所有表存在 + schema_version.version = LATEST_VERSION
test('空库跑 migrate：建全部表且版本=LATEST_VERSION', () => {
  const db = new DatabaseSync(':memory:')
  const version = migrate(db)
  assert.equal(version, LATEST_VERSION)
  const names = tableNames(db)
  for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `缺表 ${t}`)
  const row = db.prepare('SELECT version FROM schema_version').get() as unknown as {
    version: number
  }
  assert.equal(row.version, LATEST_VERSION)
  db.close()
})

// ② 已有全套表、无 schema_version 的旧库 → 认定 baseline 后续跑至最新、原有数据不丢、不报错
// （baseline 现已非最新：后续迁移 002 会重建 contributions，故老库须是完整 v1 结构才能被复制）
test('旧库（有 contributions 无 schema_version）：认定 baseline 后迁移至最新且不丢数据', () => {
  const db = new DatabaseSync(':memory:')
  // 模拟迁移框架之前的旧库：用 baseline 001 建全套表（但不建 schema_version），写入一行
  const baseline = migrations.find((m) => m.version === 1)
  assert.ok(baseline, 'baseline 001 应存在')
  baseline.up(db)
  db.prepare(
    `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
     VALUES ('c1', 1, 'u', 'acc-1', 'e@example.com', 'codex', 'plus', 'oauth', 'f.json', 'pending', 0, 'none', '', '', NULL, 100, 100)`,
  ).run()
  const version = migrate(db)
  assert.equal(version, LATEST_VERSION) // 认定 baseline 已应用，续跑后续迁移到最新
  // 原有数据仍在
  const row = db.prepare('SELECT account_id FROM contributions WHERE id = ?').get('c1') as unknown as {
    account_id: string
  }
  assert.equal(row.account_id, 'acc-1')
  // schema_version 建好且=LATEST（单行）
  const sv = db.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)
  db.close()
})

// ③ migrate 重复调用幂等：第二次不重跑、version 不变、schema_version 仍单行
test('migrate 幂等：重复调用版本不变且不重跑', () => {
  const db = new DatabaseSync(':memory:')
  const v1 = migrate(db)
  const v2 = migrate(db)
  assert.equal(v1, LATEST_VERSION)
  assert.equal(v2, LATEST_VERSION)
  const rows = db.prepare('SELECT version FROM schema_version').all() as unknown as {
    version: number
  }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].version, LATEST_VERSION)
  db.close()
})
