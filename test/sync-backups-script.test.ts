import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { backupManifestPath } from '../lib/backup-manifest.ts'
import { writeBackupManifestFixture } from './backup-manifest-fixture.ts'

const REPO = path.resolve(import.meta.dirname, '..')
const SYNC_SH = path.join(REPO, 'scripts', 'sync-backups.sh')

function createPair(snapshot: string, contents: string): void {
  fs.writeFileSync(snapshot, contents, { mode: 0o600 })
  fs.chmodSync(snapshot, 0o600)
  writeBackupManifestFixture(snapshot)
}

function installRsyncStub(root: string): { binDir: string; logFile: string } {
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  const logFile = path.join(root, 'rsync.log')
  const stub = path.join(binDir, 'rsync')
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const listArg = args.find((arg) => arg.startsWith('--files-from='))
if (!listArg) process.exit(70)
const listPath = listArg.slice('--files-from='.length)
const files = fs.readFileSync(listPath, 'utf8').trim().split('\\n').filter(Boolean)
const source = args.at(-2)
for (const file of files) {
  if (!fs.existsSync(path.join(source, file))) process.exit(71)
}
fs.appendFileSync(process.env.RSYNC_LOG, JSON.stringify({ args, files, source }) + '\\n')
const calls = fs.readFileSync(process.env.RSYNC_LOG, 'utf8').trim().split('\\n').length
if (calls === 1 && process.env.MUTATE_SOURCE_AFTER_PAYLOAD === '1') {
  fs.rmSync(path.join(process.env.BACKUP_DIR, process.env.MUTATE_NAME + '.manifest.json'), { force: true })
  fs.appendFileSync(path.join(process.env.BACKUP_DIR, process.env.MUTATE_NAME), 'changed-after-stage')
}
if (calls === 2 && process.env.FAIL_MANIFEST_PHASE === '1') process.exit(72)
`,
    { mode: 0o755 },
  )
  return { binDir, logFile }
}

function runSync(root: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const { binDir, logFile } = installRsyncStub(root)
  const result = spawnSync(SYNC_SH, ['user@host:/remote'], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      BACKUP_DIR: backupsDir,
      RSYNC_LOG: logFile,
      ...extraEnv,
    },
    encoding: 'utf8',
  })
  const calls = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        args: string[]
        files: string[]
        source: string
      })
    : []
  return { result, calls, backupsDir }
}

test('R4③: rsync transfers only complete pairs, payload first and manifests last', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-sync-pair-'))
  try {
    const backupsDir = path.join(root, 'backups')
    fs.mkdirSync(backupsDir, { recursive: true })
    createPair(path.join(backupsDir, 'backup-2026-07-29T00-00-00-aaaaaa.db'), 'daily')
    createPair(path.join(backupsDir, 'preupgrade.db'), 'pinned')

    const { result, calls } = runSync(root)
    assert.equal(result.status, 0, `sync should succeed: ${result.stderr}`)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0]!.files.sort(), ['backup-2026-07-29T00-00-00-aaaaaa.db', 'preupgrade.db'])
    assert.deepEqual(calls[1]!.files.sort(), [
      'backup-2026-07-29T00-00-00-aaaaaa.db.manifest.json',
      'preupgrade.db.manifest.json',
    ])
    for (const call of calls) {
      assert.ok(call.args.includes('--partial-dir=.rsync-partial'))
      assert.equal(call.args.includes('--partial'), false)
      assert.equal(call.args.includes('--delete'), false)
      assert.notEqual(path.resolve(call.source), path.resolve(`${backupsDir}/`), 'must transfer staged copies')
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P6-R2 sync: missing, orphan, mismatched, or non-regular pair fails before any remote call', () => {
  for (const kind of ['empty', 'missing', 'orphan', 'digest', 'snapshot-symlink', 'manifest-symlink'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `xjm-sync-${kind}-`))
    try {
      const backupsDir = path.join(root, 'backups')
      fs.mkdirSync(backupsDir, { recursive: true })
      const snapshot = path.join(backupsDir, 'backup-2026-07-29T00-00-00-aaaaaa.db')
      if (kind !== 'empty') createPair(snapshot, 'valid')
      if (kind === 'missing') fs.rmSync(backupManifestPath(snapshot))
      if (kind === 'orphan') fs.rmSync(snapshot)
      if (kind === 'digest') fs.appendFileSync(snapshot, 'tampered')
      if (kind === 'snapshot-symlink') {
        const target = path.join(root, 'snapshot-target.db')
        fs.renameSync(snapshot, target)
        fs.symlinkSync(target, snapshot)
      }
      if (kind === 'manifest-symlink') {
        const manifest = backupManifestPath(snapshot)
        const target = path.join(root, 'manifest-target.json')
        fs.renameSync(manifest, target)
        fs.symlinkSync(target, manifest)
      }

      const { result, calls } = runSync(root)
      assert.notEqual(result.status, 0, `${kind} must fail closed`)
      assert.equal(calls.length, 0, `${kind} must not contact remote`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('P6-R2 sync: local retention/concurrent mutation cannot corrupt manifest publication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-sync-concurrent-'))
  try {
    const backupsDir = path.join(root, 'backups')
    fs.mkdirSync(backupsDir, { recursive: true })
    const name = 'backup-2026-07-29T00-00-00-aaaaaa.db'
    createPair(path.join(backupsDir, name), 'stable-before-sync')

    const { result, calls } = runSync(root, {
      MUTATE_SOURCE_AFTER_PAYLOAD: '1',
      MUTATE_NAME: name,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.source, calls[1]!.source, 'both phases must use one immutable staged set')
    assert.notEqual(path.resolve(calls[0]!.source), path.resolve(`${backupsDir}/`))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P6-R2 sync: manifest-phase failure is reported after payload-only publication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-sync-manifest-fail-'))
  try {
    const backupsDir = path.join(root, 'backups')
    fs.mkdirSync(backupsDir, { recursive: true })
    createPair(path.join(backupsDir, 'backup-2026-07-29T00-00-00-aaaaaa.db'), 'valid')
    const { result, calls } = runSync(root, { FAIL_MANIFEST_PHASE: '1' })
    assert.notEqual(result.status, 0)
    assert.equal(calls.length, 2)
    assert.ok(calls[0]!.files.every((name) => name.endsWith('.db')))
    assert.ok(calls[1]!.files.every((name) => name.endsWith('.manifest.json')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
