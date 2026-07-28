import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LATEST_VERSION, migrate } from '../lib/migrate.ts'
import { assertDatabaseReady, readinessResult } from '../lib/readiness.ts'

function withDatabase(run: (db: DatabaseSync, dbPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ready-integrity-'))
  const dbPath = path.join(dir, 'app.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 50')
  migrate(db)
  try {
    run(db, dbPath)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function removeUniqueConstraint(db: DatabaseSync, tableName: string, constraint: RegExp): void {
  const tableSql = (db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
  ).get(tableName) as { sql: string }).sql
  const indexSql = (db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name",
  ).all(tableName) as { sql: string }[]).map((row) => row.sql)
  const brokenSql = tableSql.replace(constraint, '')
  assert.notEqual(brokenSql, tableSql, `前置：应能移除 ${tableName} 的 UNIQUE`)
  db.exec(`DROP TABLE "${tableName}"`)
  db.exec(brokenSql)
  for (const sql of indexSql) db.exec(sql)
}

test('readiness：健康库验证 canonical schema + 主库写能力且不留探针或业务残留', () => {
  withDatabase((db) => {
    const tableCountBefore = (db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).get() as { n: number }).n

    assert.doesNotThrow(() => assertDatabaseReady(db))
    assert.doesNotThrow(() => assertDatabaseReady(db))

    const tableCountAfter = (db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).get() as { n: number }).n
    const probeTables = db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '__xjm_readiness_probe_%'",
    ).all()
    const schemaVersion = db.prepare('SELECT version FROM schema_version').get() as { version: number }
    const auditCount = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }
    const configCount = db.prepare('SELECT COUNT(*) AS n FROM app_config').get() as { n: number }

    assert.equal(tableCountAfter, tableCountBefore)
    assert.deepEqual(probeTables, [])
    assert.equal(schemaVersion.version, LATEST_VERSION)
    assert.equal(auditCount.n, 0)
    assert.equal(configCount.n, 0)
  })
})

test('readiness：缺表、缺列与落后 schema 均 fail closed', async (t) => {
  await t.test('缺少运行必需表', () => {
    withDatabase((db) => {
      db.exec('DROP TABLE redeem_items')
      assert.throws(() => assertDatabaseReady(db), /redeem_items|schema/i)
    })
  })

  await t.test('缺少迁移定义的关键列', () => {
    withDatabase((db) => {
      db.exec('ALTER TABLE redeem_items DROP COLUMN fulfillment')
      assert.throws(() => assertDatabaseReady(db), /fulfillment|schema/i)
    })
  })

  await t.test('schema_version 落后', () => {
    withDatabase((db) => {
      db.prepare('UPDATE schema_version SET version=?').run(LATEST_VERSION - 1)
      assert.throws(() => assertDatabaseReady(db), /schema.*版本不匹配|版本不匹配/i)
    })
  })

  await t.test('schema_version 超前也不冒充当前进程就绪', () => {
    withDatabase((db) => {
      db.prepare('UPDATE schema_version SET version=?').run(LATEST_VERSION + 1)
      assert.throws(() => assertDatabaseReady(db), /schema.*版本不匹配|版本不匹配/i)
    })
  })

  await t.test('daily_settlements 幂等唯一约束缺失', () => {
    withDatabase((db) => {
      removeUniqueConstraint(db, 'daily_settlements', /,\s*UNIQUE\s*\(contribution_id,\s*date\)/i)
      assert.throws(() => assertDatabaseReady(db), /daily_settlements.*索引|唯一约束/i)
    })
  })

  await t.test('point_ledger 发分幂等唯一约束缺失', () => {
    withDatabase((db) => {
      removeUniqueConstraint(db, 'point_ledger', /,\s*UNIQUE\s*\(reason,\s*ref\)/i)
      assert.throws(() => assertDatabaseReady(db), /point_ledger.*索引|唯一约束/i)
    })
  })
})

test('readiness：真实只读连接返回脱敏 503，健康库不被污染', () => {
  withDatabase((db, dbPath) => {
    const readOnly = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.throws(() => assertDatabaseReady(readOnly), /read.?only|readonly|write|只读/i)
      assert.deepEqual(readinessResult(() => assertDatabaseReady(readOnly)), {
        status: 503,
        body: { ok: false, code: 'DATABASE_NOT_READY', summary: '数据库尚未就绪' },
      })
    } finally {
      readOnly.close()
    }
  })
})

test('readiness：写锁失败后释放安全，后续探测恢复且无残留', () => {
  withDatabase((db, dbPath) => {
    const blocked = new DatabaseSync(dbPath)
    blocked.exec('PRAGMA busy_timeout = 20')
    db.exec('BEGIN IMMEDIATE')
    try {
      assert.deepEqual(readinessResult(() => assertDatabaseReady(blocked)), {
        status: 503,
        body: { ok: false, code: 'DATABASE_NOT_READY', summary: '数据库尚未就绪' },
      })
    } finally {
      db.exec('ROLLBACK')
    }

    assert.doesNotThrow(() => assertDatabaseReady(blocked))
    assert.deepEqual(blocked.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '__xjm_readiness_probe_%'",
    ).all(), [])
    blocked.close()
  })
})
