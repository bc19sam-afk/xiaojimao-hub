import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { assertDatabaseReady } from './readiness'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')
const IN_MEMORY = DB_PATH === ':memory:' || DB_PATH.startsWith('file::memory:')

// Readiness deliberately starts with a fresh connection for every request. The fast gate must
// pass before importing the resident DB singleton, otherwise a broken schema can poison a DB-backed
// module and a write lock can inherit the business connection's multi-second timeout.
export async function assertReadinessDatabase(): Promise<void> {
  // Do not create a missing production database merely by probing it.
  if (!IN_MEMORY && !DB_PATH.startsWith('file:') && !fs.existsSync(DB_PATH)) {
    throw new Error('readiness database file is missing')
  }

  const db = new DatabaseSync(DB_PATH)
  try {
    const probe = IN_MEMORY ? undefined : () => new DatabaseSync(DB_PATH)
    assertDatabaseReady(db, probe)
  } finally {
    db.close()
  }

  // P6-R2 resident/disk gate: the application connection must still be alive and bound to the
  // same dev/inode, while a fresh disk connection sees the current schema. checkReady catches
  // initialization failures and remains retryable because lib/db opens its singleton lazily.
  const { checkReady } = await import('./ready')
  if (!(await checkReady())) throw new Error('resident database is not ready')
}
