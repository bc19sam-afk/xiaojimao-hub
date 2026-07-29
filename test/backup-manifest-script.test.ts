import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { backupDb } from '../lib/backup.ts'
import { backupManifestPath, verifyBackupPair } from '../lib/backup-manifest.ts'

const REPO = path.resolve(import.meta.dirname, '..')
const MANIFEST_SCRIPT = path.join(REPO, 'scripts', 'backup-manifest.ts')

test('manifest CLI does not expose a generic create command for arbitrary database files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-manifest-cli-'))
  try {
    const snapshot = path.join(root, 'uncontrolled.db')
    fs.writeFileSync(snapshot, 'not produced by the controlled VACUUM chain', { mode: 0o600 })
    fs.chmodSync(snapshot, 0o600)

    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, 'create', snapshot], {
      cwd: REPO,
      encoding: 'utf8',
    })

    assert.notEqual(result.status, 0, 'generic create would let an arbitrary bare copy claim controlled provenance')
    assert.equal(fs.existsSync(`${snapshot}.manifest.json`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('production manifest module does not export a generic provenance writer', async () => {
  const manifestModule = await import('../lib/backup-manifest.ts')
  assert.equal('writeBackupManifest' in manifestModule, false)
  assert.equal('buildBackupManifest' in manifestModule, false)
})

test('manifest verifier rejects reordered JSON fields just like restore.sh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-manifest-order-'))
  try {
    const dbPath = path.join(root, 'app.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE marker (value TEXT NOT NULL)')
    db.prepare('INSERT INTO marker (value) VALUES (?)').run('canonical')
    db.close()
    const snapshot = backupDb(dbPath, path.join(root, 'backups'), 1)
    const manifestPath = backupManifestPath(snapshot)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const reordered = {
      sha256: manifest.sha256,
      size: manifest.size,
      name: manifest.name,
      method: manifest.method,
      version: manifest.version,
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(reordered)}\n`, { mode: 0o600 })
    fs.chmodSync(manifestPath, 0o600)
    assert.throws(() => verifyBackupPair(snapshot), /规范序列化/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent pin serializes target checks and preserves the losing source pair', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-manifest-pin-race-'))
  try {
    const dbPath = path.join(root, 'app.db')
    const backupsDir = path.join(root, 'backups')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE marker (value TEXT NOT NULL)')
    db.prepare('INSERT INTO marker (value) VALUES (?)').run('first')
    const first = backupDb(dbPath, backupsDir, 10)
    db.exec("UPDATE marker SET value = 'second'")
    const second = backupDb(dbPath, backupsDir, 10)
    db.close()

    const target = path.join(backupsDir, 'preupgrade.db')
    const publishLock = new DatabaseSync(path.join(backupsDir, '.backup.lock'))
    publishLock.exec('BEGIN IMMEDIATE')

    const runPin = (source: string) => {
      const child = spawn(process.execPath, [MANIFEST_SCRIPT, 'pin', source, target], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      const result = new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
        child.once('close', (code) => resolve({ status: code ?? -1, stdout, stderr }))
      })
      return { child, result }
    }

    const left = runPin(first)
    const right = runPin(second)
    await sleep(1500)
    assert.equal(left.child.exitCode, null, 'first pin must be waiting on the held publication lock')
    assert.equal(right.child.exitCode, null, 'second pin must be waiting on the held publication lock')
    publishLock.close()

    const results = await Promise.all([left.result, right.result])
    assert.equal(
      results.filter((result) => result.status === 0).length,
      1,
      `exactly one pin may claim the target:\n${JSON.stringify(results)}`,
    )

    verifyBackupPair(target)
    const remainingSources = [first, second].filter((source) => fs.existsSync(source))
    assert.equal(remainingSources.length, 1, 'the losing source payload must remain available')
    verifyBackupPair(remainingSources[0])

    for (const snapshot of [first, second, target]) {
      assert.equal(
        fs.existsSync(snapshot),
        fs.existsSync(backupManifestPath(snapshot)),
        `pin must not leave an orphan pair member: ${snapshot}`,
      )
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
