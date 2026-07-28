import type { DatabaseSync } from 'node:sqlite'
import { assertSchemaMatchesMigrations, LATEST_VERSION, readSchemaVersion } from './migrate'

export interface ReadinessResult {
  status: 200 | 503
  body:
    | { ok: true }
    | { ok: false; code: 'DATABASE_NOT_READY'; summary: '数据库尚未就绪' }
}

function assertWritable(db: DatabaseSync): void {
  let transactionStarted = false
  let failure: unknown
  try {
    // BEGIN IMMEDIATE 同时验证主库写权限与当前能否取得写锁；零命中 UPDATE 不改变任何业务行。
    db.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    db.prepare('UPDATE schema_version SET version=version WHERE rowid=-1').run()
  } catch (error) {
    failure = error
  }

  if (transactionStarted) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      failure ??= rollbackError
    }
  }
  if (failure) throw failure
}

// 运行期 readiness 与部署期“可迁移”不同：当前进程只在版本严格相等、canonical schema 完整且
// 主 SQLite 可取得写锁时接流量。探针只覆盖本地 DB/schema/write，不声明外部 CPA/CPAMP 就绪。
export function assertDatabaseReady(db: DatabaseSync): void {
  const ping = db.prepare('SELECT 1 AS ok').get() as unknown as { ok: number } | undefined
  if (ping?.ok !== 1) throw new Error('database ping failed')

  const version = readSchemaVersion(db)
  if (version !== LATEST_VERSION) {
    throw new Error(`[db] readiness schema 版本不匹配（当前 ${version ?? 0}，需要 ${LATEST_VERSION}）`)
  }
  assertSchemaMatchesMigrations(db)
  assertWritable(db)
}

export function readinessResult(probe: () => void): ReadinessResult {
  try {
    probe()
    return { status: 200, body: { ok: true } }
  } catch {
    return {
      status: 503,
      body: { ok: false, code: 'DATABASE_NOT_READY', summary: '数据库尚未就绪' },
    }
  }
}
