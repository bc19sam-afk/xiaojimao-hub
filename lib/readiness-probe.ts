import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { assertDatabaseReady } from './readiness'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')
const IN_MEMORY = DB_PATH === ':memory:' || DB_PATH.startsWith('file::memory:')

// Readiness deliberately opens a fresh connection for every request. It must not depend on
// the singleton in lib/db.ts: a failed first module evaluation is cached by ESM and would make
// a repaired database report 503 forever until process restart.
export function assertReadinessDatabase(): void {
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
}
