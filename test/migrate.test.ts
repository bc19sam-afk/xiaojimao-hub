import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'

const root = path.resolve(import.meta.dirname, '..')

const CONCURRENT_MIGRATOR_SOURCE = `
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.XJM_MIGRATE_ROOT
const dbPath = process.env.XJM_MIGRATE_DB
const readyPath = process.env.XJM_MIGRATE_READY
const goPath = process.env.XJM_MIGRATE_GO
const { migrate } = await import(pathToFileURL(path.join(root, 'lib/migrate.ts')).href)
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')
fs.writeFileSync(readyPath, 'ready')
const waitCell = new Int32Array(new SharedArrayBuffer(4))
while (!fs.existsSync(goPath)) Atomics.wait(waitCell, 0, 0, 5)
const version = migrate(db)
db.close()
process.stdout.write(String(version))
`

const EXPECTED_TABLES = [
  'contributions',
  'app_config',
  'point_rules',
  'redeem_items',
  'point_ledger',
  'redemptions',
  'rejections',
  'cdk_codes',
  'audit_log',
  'redeem_item_create_requests',
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

function databaseAtVersion(target: number): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const migration of migrations
    .filter((entry) => entry.version <= target)
    .sort((a, b) => a.version - b.version)) {
    migration.up(db)
  }
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(target)
  return db
}

function databaseFileAtVersion(dbPath: string, target: number): void {
  const db = new DatabaseSync(dbPath)
  try {
    for (const migration of migrations
      .filter((entry) => entry.version <= target)
      .sort((a, b) => a.version - b.version)) {
      migration.up(db)
    }
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(target)
  } finally {
    db.close()
  }
}

function spawnConcurrentMigrator(args: {
  dbPath: string
  readyPath: string
  goPath: string
}): { child: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(
    process.execPath,
    ['--import', path.join(root, 'test/setup.mjs'), '--input-type=module', '--eval', CONCURRENT_MIGRATOR_SOURCE],
    {
      cwd: root,
      env: {
        ...process.env,
        XJM_MIGRATE_ROOT: root,
        XJM_MIGRATE_DB: args.dbPath,
        XJM_MIGRATE_READY: args.readyPath,
        XJM_MIGRATE_GO: args.goPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  child.stdin.end()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done }
}

async function waitForFiles(paths: string[], children: ChildProcessWithoutNullStreams[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (paths.every((file) => fs.existsSync(file))) return
    const exited = children.find((child) => child.exitCode !== null || child.signalCode !== null)
    if (exited) throw new Error('concurrent migrator exited before reaching the barrier')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('concurrent migrators did not reach the barrier')
}

test('迁移013：为商品 create intent 建持久化唯一幂等表，升级保数据且二次运行幂等', () => {
  assert.ok(migrations.some((entry) => entry.version === 13), '应存在 migration 013')
  const db = databaseAtVersion(12)
  db.prepare(
    `INSERT INTO redeem_items
     (name, description, cost, kind, enabled, sort, config, fulfillment, per_user_limit)
     VALUES ('升级前商品', '', 10, 'timed_quota', 1, 0, '{}', 'placeholder', 0)`,
  ).run()

  assert.equal(migrate(db), LATEST_VERSION)
  assert.equal(migrate(db), LATEST_VERSION)
  assert.equal((db.prepare(
    "SELECT COUNT(*) AS n FROM redeem_items WHERE name='升级前商品'",
  ).get() as { n: number }).n, 1)
  const columns = db.prepare('PRAGMA table_info(redeem_item_create_requests)').all() as Array<{ name: string }>
  assert.deepEqual(columns.map((column) => column.name), [
    'request_key',
    'payload_hash',
    'item_id',
    'created_at',
  ])
  db.prepare(
    `INSERT INTO redeem_item_create_requests (request_key, payload_hash, item_id, created_at)
     VALUES ('intent-1234567890', 'hash-a', 1, 1)`,
  ).run()
  assert.throws(() => db.prepare(
    `INSERT INTO redeem_item_create_requests (request_key, payload_hash, item_id, created_at)
     VALUES ('intent-1234567890', 'hash-a', 1, 2)`,
  ).run(), /UNIQUE|constraint/i)
  db.close()
})

test('迁移013：同名不兼容残表使迁移 fail closed 并回滚版本，不伪装成功', () => {
  const db = databaseAtVersion(12)
  db.exec('CREATE TABLE redeem_item_create_requests (request_key TEXT PRIMARY KEY)')
  assert.throws(() => migrate(db), /already exists|redeem_item_create_requests/i)
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 12)
  assert.deepEqual(
    (db.prepare('PRAGMA table_info(redeem_item_create_requests)').all() as Array<{ name: string }>).map((column) => column.name),
    ['request_key'],
  )
  db.close()
})

test('迁移013：两进程同时升级同一 v12 库只创建一次并共同读到 v13', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-migrate-013-concurrent-'))
  const dbPath = path.join(dir, 'app.db')
  const goPath = path.join(dir, 'go')
  const readyPaths = [path.join(dir, 'ready-1'), path.join(dir, 'ready-2')]
  databaseFileAtVersion(dbPath, 12)

  const workers = readyPaths.map((readyPath) => spawnConcurrentMigrator({ dbPath, readyPath, goPath }))
  try {
    await waitForFiles(readyPaths, workers.map(({ child }) => child))
    fs.writeFileSync(goPath, 'go')
    const results = await Promise.all(workers.map(({ done }) => done))
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, String(LATEST_VERSION))
    }

    const db = new DatabaseSync(dbPath)
    try {
      assert.equal(
        (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
        LATEST_VERSION,
      )
      assert.equal(
        (db.prepare(
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name='redeem_item_create_requests'",
        ).get() as { n: number }).n,
        1,
      )
      assert.deepEqual(
        (db.prepare('PRAGMA table_info(redeem_item_create_requests)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
        ['request_key', 'payload_hash', 'item_id', 'created_at'],
      )
    } finally {
      db.close()
    }
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await Promise.allSettled(workers.map(({ done }) => done))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
