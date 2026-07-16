import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, LATEST_VERSION } from '../lib/migrate.ts'

// ============================================================================
// 半建库回归（P0-B-4，问题 2）：框架之前的旧建表是「单条多语句 exec」，非事务，
// 中途崩溃会留下"只建了 contributions、缺其余 baseline 表、无 schema_version"的半建库。
// 旧 startingVersion 只要见到 contributions 就认定 baseline 已应用(1)、跳过 migration 001，
// 半建库遂被误判已迁移；启动 seedDefaults 首条查 point_rules 即抛，库起不来且不自愈。
// 修复后：无 schema_version 一律从 0 跑起，001（全 CREATE IF NOT EXISTS）补全缺表。
// ============================================================================

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

// 构造半建库：只建 contributions（列与 baseline 001 一字不差，含 account_id 列级 UNIQUE，
// 以便 migration 002 的显式列复制能命中），塞一行数据；不建其余 baseline 表、不建 schema_version。
function makeHalfBuilt(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE contributions (
      id            TEXT PRIMARY KEY,
      linuxdo_id    INTEGER NOT NULL,
      username      TEXT NOT NULL,
      account_id    TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL,
      provider      TEXT NOT NULL DEFAULT 'codex',
      plan          TEXT NOT NULL,
      method        TEXT NOT NULL,
      auth_file_name TEXT NOT NULL,
      verify_status TEXT NOT NULL,
      points        INTEGER NOT NULL DEFAULT 0,
      reward_status TEXT NOT NULL,
      reward_text   TEXT NOT NULL DEFAULT '',
      reward_note   TEXT NOT NULL DEFAULT '',
      reward_code   TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
     VALUES ('hb1', 7, 'oldu', 'hb-acc-1', 'e@example.com', 'codex', 'pro', 'oauth', 'f.json', 'active', 30, 'granted', '', '', NULL, 100, 100)`,
  ).run()
}

// ① 单元：半建库直接跑 migrate() → 补全全部 baseline 表、原数据不丢、版本=LATEST
test('半建库跑 migrate()：补全缺表、原数据不丢、版本=LATEST', () => {
  const db = new DatabaseSync(':memory:')
  makeHalfBuilt(db)
  // 前置确认确实是半建：有 contributions，缺 point_rules，无 schema_version
  const pre = tableNames(db)
  assert.ok(pre.has('contributions'))
  assert.ok(!pre.has('point_rules'), '前置：point_rules 应缺失（半建库）')
  assert.ok(!pre.has('schema_version'), '前置：不应有 schema_version')

  const version = migrate(db)
  assert.equal(version, LATEST_VERSION) // 未被误判已迁移，跑满迁移链

  // 6 张 baseline 表齐全
  const names = tableNames(db)
  for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `缺表 ${t}`)

  // 原有数据不丢（经 migration 002 重建仍在）
  const row = db.prepare('SELECT account_id, points FROM contributions WHERE id = ?').get('hb1') as unknown as {
    account_id: string
    points: number
  }
  assert.equal(row.account_id, 'hb-acc-1')
  assert.equal(row.points, 30)

  // schema_version 单行 = LATEST
  const sv = db.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)

  // point_rules 已补建、可查询（修复前 seedDefaults 首条即在此抛错）——空表待 seed
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM point_rules').get() as unknown as { n: number }
  assert.equal(cnt.n, 0)
  db.close()
})

// ② 集成：半建库经 lib/db.ts 的 openDb（mock 默认自动迁移）自愈 → 数据不丢且 seedDefaults 正常播种
// 复现真实故障路径「openDb → seedDefaults 查缺表抛错、库起不来」，证明其已修复。
let liveDb: typeof import('../lib/db.ts').db
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-hb-'))
  const dbPath = path.join(tmpDir, 'app.db')
  // 先把半建库落到磁盘（独立连接，建完即关）
  const seed = new DatabaseSync(dbPath)
  makeHalfBuilt(seed)
  seed.close()
  // 再让 lib/db.ts 打开它：MOCK 默认开 → openDb 自动 migrate()+seedDefaults()
  process.env.MOCK = 'true'
  process.env.DB_PATH = dbPath
  ;({ db: liveDb } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('半建库经 openDb 自愈：原数据不丢且 seedDefaults 正常播种', () => {
  // 原有行仍在（自动 001 补表 + 002 重建后不丢）
  const mine = liveDb.all().find((c) => c.id === 'hb1')
  assert.ok(mine, '半建库原有行应在自愈后保留')
  assert.equal(mine.accountId, 'hb-acc-1')
  // seedDefaults 正常跑：point_rules 有种子行（修复前此处 openDb 直接抛、库起不来）
  assert.ok(liveDb.listPointRules().length > 0, 'seedDefaults 应已播种 point_rules 种子行')
})
