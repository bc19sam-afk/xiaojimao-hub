import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { backupManifestPath, verifyBackupPair } from '../lib/backup-manifest.ts'
import { writeBackupManifestFixture } from './backup-manifest-fixture.ts'

const REPO = path.resolve(import.meta.dirname, '..')
const ENTRYPOINT = path.join(REPO, 'docker-entrypoint.sh')

function createPair(snapshot: string, contents: string): void {
  fs.mkdirSync(path.dirname(snapshot), { recursive: true })
  fs.writeFileSync(snapshot, contents, { mode: 0o600 })
  fs.chmodSync(snapshot, 0o600)
  writeBackupManifestFixture(snapshot)
}

function installNodeStub(root: string): { binDir: string; logFile: string } {
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  const logFile = path.join(root, 'node.log')
  const stubJs = path.join(root, 'node-stub.mjs')
  fs.writeFileSync(
    stubJs,
    `import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
fs.appendFileSync(process.env.NODE_LOG, JSON.stringify(args) + '\\n')

function createPair(name, contents) {
  const snapshot = path.join(process.env.BACKUP_DIR, name)
  fs.writeFileSync(snapshot, contents, { mode: 0o600 })
  fs.chmodSync(snapshot, 0o600)
  const body = {
    version: 1,
    method: 'sqlite-vacuum-into',
    name,
    size: fs.statSync(snapshot).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex'),
  }
  fs.writeFileSync(snapshot + '.manifest.json', JSON.stringify(body) + '\\n', { mode: 0o600 })
  fs.chmodSync(snapshot + '.manifest.json', 0o600)
}

if (args[0] === '-e') {
  if (args[1]?.includes('LATEST_VERSION')) console.log('99')
  process.exit(0)
}
if (args[0] === 'scripts/schema-check.ts') {
  const state = process.env.NODE_LOG + '.schema-count'
  const count = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0
  fs.writeFileSync(state, String(count + 1))
  process.exit(count === 0 || process.env.POSTCHECK_FAIL === '1' ? 1 : 0)
}
if (args[0] === 'scripts/backup.ts') {
  if (process.env.BACKUP_MODE === 'bare') {
    const snapshot = path.join(process.env.BACKUP_DIR, 'backup-2026-07-29T00-00-00-aaaaaa.db')
    fs.writeFileSync(snapshot, 'bare-new', { mode: 0o600 })
  } else {
    createPair('backup-2026-07-29T00-00-00-aaaaaa.db', 'new-snapshot-a')
    if (process.env.BACKUP_MODE === 'two') {
      createPair('backup-2026-07-29T00-00-01-bbbbbb.db', 'new-snapshot-b')
    }
  }
  process.exit(0)
}
if (args[0] === 'scripts/backup-manifest.ts') {
  const result = spawnSync(process.env.REAL_NODE, args, {
    cwd: process.env.REPO,
    env: process.env,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}
if (args[0] === 'scripts/migrate.ts' || args[0] === 'server.js') process.exit(0)
process.exit(91)
`,
    { mode: 0o600 },
  )
  const nodeStub = path.join(binDir, 'node')
  fs.writeFileSync(nodeStub, `#!/bin/sh\nexec "$REAL_NODE" "$NODE_STUB" "$@"\n`, { mode: 0o755 })
  return { binDir, logFile }
}

function runEntrypoint(
  root: string,
  options: { backupMode?: 'valid' | 'bare' | 'two'; postcheckFail?: boolean } = {},
) {
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const dbPath = path.join(dataDir, 'app.db')
  fs.writeFileSync(dbPath, 'live-db', { mode: 0o600 })
  const { binDir, logFile } = installNodeStub(root)
  const result = spawnSync(ENTRYPOINT, [], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      NODE_STUB: path.join(root, 'node-stub.mjs'),
      NODE_LOG: logFile,
      REPO,
      MOCK: 'false',
      DB_PATH: dbPath,
      BACKUP_DIR: backupsDir,
      BACKUP_MODE: options.backupMode ?? 'valid',
      POSTCHECK_FAIL: options.postcheckFail ? '1' : '0',
    },
    encoding: 'utf8',
  })
  const calls = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
    : []
  return { result, calls, dataDir, backupsDir }
}

test('P6-R2 entrypoint: pins the unique new snapshot as a verified preupgrade pair', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-entrypoint-pair-'))
  try {
    const { result, calls, dataDir, backupsDir } = runEntrypoint(root, { postcheckFail: true })
    assert.equal(result.status, 1, `post-check should stop the fixture after pinning: ${result.stderr}`)
    const pinned = path.join(backupsDir, 'preupgrade.db')
    const manifest = verifyBackupPair(pinned)
    assert.equal(manifest.name, 'preupgrade.db')
    assert.equal(fs.readFileSync(pinned, 'utf8'), 'new-snapshot-a')
    assert.equal(fs.existsSync(path.join(dataDir, '.upgrade-in-progress')), true)
    assert.equal(
      calls.filter((args) => args[0] === 'scripts/backup-manifest.ts' && args[1] === 'pin').length,
      1,
    )
    assert.deepEqual(
      fs.readdirSync(backupsDir).filter((name) => name.startsWith('backup-')),
      [],
      'source snapshot and source manifest must both be consumed by pinning',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P6-R2 entrypoint: rejects a backup that publishes a bare DB without its manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-entrypoint-bare-'))
  try {
    const { result, calls, backupsDir } = runEntrypoint(root, { backupMode: 'bare' })
    assert.notEqual(result.status, 0)
    assert.equal(fs.existsSync(path.join(backupsDir, 'preupgrade.db')), false)
    assert.equal(calls.some((args) => args[0] === 'scripts/migrate.ts'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P6-R2 entrypoint: concurrent publication of two new valid pairs is ambiguous and stops migration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-entrypoint-concurrent-'))
  try {
    const { result, calls, backupsDir } = runEntrypoint(root, { backupMode: 'two' })
    assert.notEqual(result.status, 0)
    assert.equal(fs.existsSync(path.join(backupsDir, 'preupgrade.db')), false)
    assert.equal(calls.some((args) => args[0] === 'scripts/migrate.ts'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P6-R2 entrypoint: an existing marker is reusable only when snapshot and manifest still verify', () => {
  const validRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-entrypoint-marker-valid-'))
  const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-entrypoint-marker-bare-'))
  try {
    const validPinned = path.join(validRoot, 'data', 'backups', 'preupgrade.db')
    createPair(validPinned, 'old-valid-pinned')
    fs.writeFileSync(path.join(validRoot, 'data', '.upgrade-in-progress'), `${validPinned}\n`, { mode: 0o600 })
    const valid = runEntrypoint(validRoot, { postcheckFail: true })
    assert.equal(valid.result.status, 1)
    assert.equal(valid.calls.some((args) => args[0] === 'scripts/backup.ts'), false)
    verifyBackupPair(validPinned)

    const invalidPinned = path.join(invalidRoot, 'data', 'backups', 'preupgrade.db')
    fs.mkdirSync(path.dirname(invalidPinned), { recursive: true })
    fs.writeFileSync(invalidPinned, 'unsafe-bare', { mode: 0o600 })
    fs.writeFileSync(path.join(invalidRoot, 'data', '.upgrade-in-progress'), `${invalidPinned}\n`, { mode: 0o600 })
    const invalid = runEntrypoint(invalidRoot)
    assert.notEqual(invalid.result.status, 0)
    assert.equal(invalid.calls.some((args) => args[0] === 'scripts/backup.ts'), false)
    assert.equal(invalid.calls.some((args) => args[0] === 'scripts/migrate.ts'), false)
  } finally {
    fs.rmSync(validRoot, { recursive: true, force: true })
    fs.rmSync(invalidRoot, { recursive: true, force: true })
  }
})

test('P6-R2 entrypoint: replaces an older valid pinned pair only after a new pair exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-entrypoint-retention-'))
  try {
    const pinned = path.join(root, 'data', 'backups', 'preupgrade.db')
    createPair(pinned, 'old-pinned')
    const oldDigest = crypto.createHash('sha256').update('old-pinned').digest('hex')
    assert.equal(verifyBackupPair(pinned).sha256, oldDigest)

    const { result, backupsDir } = runEntrypoint(root, { postcheckFail: true })
    assert.equal(result.status, 1, result.stderr)
    const replacement = verifyBackupPair(path.join(backupsDir, 'preupgrade.db'))
    assert.notEqual(replacement.sha256, oldDigest)
    assert.equal(fs.existsSync(backupManifestPath(path.join(backupsDir, 'preupgrade.db'))), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P6-R2 entrypoint: never overwrites a half-published old preupgrade payload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-entrypoint-old-bare-'))
  try {
    const pinned = path.join(root, 'data', 'backups', 'preupgrade.db')
    fs.mkdirSync(path.dirname(pinned), { recursive: true })
    fs.writeFileSync(pinned, 'old-bare-payload', { mode: 0o600 })

    const { result, calls } = runEntrypoint(root)
    assert.notEqual(result.status, 0)
    assert.equal(fs.readFileSync(pinned, 'utf8'), 'old-bare-payload')
    assert.equal(fs.existsSync(backupManifestPath(pinned)), false)
    assert.equal(calls.some((args) => args[0] === 'scripts/migrate.ts'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
