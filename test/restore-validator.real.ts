import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

const REPO = path.resolve(import.meta.dirname, '..')
const RESTORE_SH = path.join(REPO, 'scripts', 'restore.sh')
const SERVICE_ENV_SENTINELS = {
  SESSION_SECRET: 'xjm-real-validator-session-sentinel',
  CPA_API_KEY: 'xjm-real-validator-cpa-sentinel',
  TZ: 'Etc/GMT+12',
}

type DockerInspect = {
  Id: string
  Image: string
  State: { Running: boolean }
  Config: {
    Env: string[] | null
    User: string
    Entrypoint: string[] | null
    Cmd: string[] | null
  }
  HostConfig: {
    NetworkMode: string
    ReadonlyRootfs: boolean
    CapDrop: string[] | null
    SecurityOpt: string[] | null
  }
  Mounts: Array<{
    Type: string
    Source: string
    Destination: string
    RW: boolean
  }>
}

type ChildResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function docker(...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('docker', args, { cwd: REPO, encoding: 'utf8' })
}

function mustDocker(...args: string[]): string {
  const result = docker(...args)
  assert.equal(
    result.status,
    0,
    `docker ${args.join(' ')} failed\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`,
  )
  return String(result.stdout || '').trim()
}

function imageIdForEquivalentRuntime(): string {
  const candidates = ['node:26-bookworm', 'node:26-alpine', 'node:26']
  for (const candidate of candidates) {
    const result = docker('image', 'inspect', '--format', '{{.Id}}', candidate)
    const id = String(result.stdout || '').trim()
    if (result.status === 0 && /^sha256:[0-9a-f]{64}$/.test(id)) {
      assert.equal(mustDocker('image', 'inspect', '--format', '{{.Id}}', id), id)
      return id
    }
  }
  assert.fail(
    `no local Node 26 image is available; build the Compose app image or load one of: ${candidates.join(', ')}`,
  )
}

function extractFunction(source: string, name: string): string {
  const startToken = `${name}() {`
  const start = source.indexOf(startToken)
  assert.ok(start >= 0, `missing ${name} in ${RESTORE_SH}`)
  const tail = source.slice(start)
  const endMatch = /^}\n/m.exec(tail)
  assert.ok(endMatch?.index !== undefined, `unterminated ${name} in ${RESTORE_SH}`)
  return tail.slice(0, endMatch.index + 2)
}

function validatorFunctions(): string {
  const source = fs.readFileSync(RESTORE_SH, 'utf8')
  return [
    extractFunction(source, 'validator_cleanup_container'),
    extractFunction(source, 'node_with_snapshot'),
  ].join('\n\n')
}

function shellHarness(functions: string): string {
  return `set -eu
RESTORE_CONTAINER_IMAGE=$1
VALIDATOR_CONTAINER_ID=
${functions}
node_with_snapshot "$2" "$3"
`
}

function snapshotProbeScript(): string {
  return `
const fs = require("fs")
const { DatabaseSync } = require("node:sqlite")
process.on("SIGUSR2", () => process.exit(0))
const stat = fs.statSync("/snap.db")
if ((stat.mode & 0o777) !== 0o600) process.exit(31)
const db = new DatabaseSync("file:/snap.db?immutable=1", { readOnly: true })
try {
  const row = db.prepare("SELECT value FROM validator_probe WHERE id = 1").get()
  if (!row || row.value !== "snapshot-readable") process.exit(32)
  const check = db.prepare("PRAGMA quick_check").get()
  if (!check || check.quick_check !== "ok") process.exit(33)
} finally {
  db.close()
}
process.stdout.write("XJM_VALIDATOR_SNAPSHOT_READ_OK\\n")
setInterval(() => {}, 1000)
`
}

function mutationProbeScript(): string {
  return 'process.stdout.write("XJM_VALIDATOR_MUTANT_STARTED\\n")'
}

function makeSqlite(file: string, marker: string): void {
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE validator_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO validator_probe (id, value) VALUES (1, ?)').run(marker)
  } finally {
    db.close()
  }
  fs.chmodSync(file, 0o600)
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function stableStat(file: string): Record<string, string> {
  const stat = fs.statSync(file, { bigint: true })
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    birthtimeNs: String(stat.birthtimeNs),
  }
}

function inspectContainer(id: string): DockerInspect {
  const raw = mustDocker('inspect', id)
  const rows = JSON.parse(raw) as DockerInspect[]
  assert.equal(rows.length, 1, `expected one inspect record for ${id}`)
  return rows[0]
}

function allContainerIds(): string[] {
  const result = docker('ps', '-aq', '--no-trunc')
  assert.equal(result.status, 0, `cannot enumerate Docker containers: ${result.stderr || ''}`)
  return String(result.stdout || '').trim().split('\n').filter(Boolean)
}

function validatorContainersFor(snapshot: string): string[] {
  const ids = allContainerIds()
  if (ids.length === 0) return []
  const result = docker('inspect', ...ids)
  const rows = result.status === 0
    ? JSON.parse(String(result.stdout || '[]')) as DockerInspect[]
    : ids.flatMap((id) => {
      const single = docker('inspect', id)
      return single.status === 0
        ? JSON.parse(String(single.stdout || '[]')) as DockerInspect[]
        : []
    })
  return rows
    .filter((row) => row.Mounts.some(
      (mount) => mount.Type === 'bind' && mount.Source === snapshot && mount.Destination === '/snap.db',
    ))
    .map((row) => row.Id)
}

async function waitUntil<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = probe()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  if (lastError) throw lastError
  assert.fail(`condition not met within ${timeoutMs}ms`)
}

function collect(child: ReturnType<typeof spawn>): {
  result: Promise<ChildResult>
  stdout: () => string
  stderr: () => string
} {
  let stdout = ''
  let stderr = ''
  assert.ok(child.stdout, 'validator child stdout must be piped')
  assert.ok(child.stderr, 'validator child stderr must be piped')
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { result, stdout: () => stdout, stderr: () => stderr }
}

async function removeValidatorContainers(snapshot: string): Promise<void> {
  for (const id of validatorContainersFor(snapshot)) {
    docker('rm', '-f', id)
  }
  await waitUntil(() => validatorContainersFor(snapshot).length === 0 ? true : undefined)
}

async function resultWithin(result: Promise<ChildResult>, timeoutMs = 10_000): Promise<ChildResult> {
  return Promise.race([
    result,
    delay(timeoutMs).then(() => assert.fail(`validator child did not exit within ${timeoutMs}ms`)),
  ])
}

test('real Docker snapshot validator enforces the isolated exact-image contract', async (t) => {
  const server = docker('version', '--format', '{{.Server.Version}}')
  assert.equal(server.status, 0, `Docker daemon is required: ${server.stderr || ''}`)

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-validator-real-')))
  const snapshot = path.join(root, 'snapshot.db')
  const liveDb = path.join(root, 'app.db')
  makeSqlite(snapshot, 'snapshot-readable')
  makeSqlite(liveDb, 'live-database-must-not-change')
  const liveShaBefore = sha256(liveDb)
  const liveStatBefore = stableStat(liveDb)
  const imageId = imageIdForEquivalentRuntime()
  const imageEnv = JSON.parse(
    mustDocker('image', 'inspect', '--format', '{{json .Config.Env}}', imageId) || '[]',
  ) as string[] | null
  const functions = validatorFunctions()
  const child = spawn(
    'sh',
    ['-c', shellHarness(functions), 'restore-validator-real', imageId, snapshot, snapshotProbeScript()],
    {
      cwd: REPO,
      env: { ...process.env, ...SERVICE_ENV_SENTINELS },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const collected = collect(child)
  let validatorId = ''

  try {
    validatorId = await waitUntil(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.fail(
          `validator exited before inspection: code=${child.exitCode} signal=${child.signalCode}\n` +
          `stdout:\n${collected.stdout()}\nstderr:\n${collected.stderr()}`,
        )
      }
      const ids = validatorContainersFor(snapshot)
      if (ids.length !== 1) return undefined
      const inspected = inspectContainer(ids[0])
      if (!inspected.State.Running) return undefined
      if (!collected.stdout().includes('XJM_VALIDATOR_SNAPSHOT_READ_OK')) return undefined
      return ids[0]
    })
    const inspected = inspectContainer(validatorId)

    await t.test('uses the verified exact image ID', () => {
      assert.equal(inspected.Image, imageId)
      assert.equal(mustDocker('image', 'inspect', '--format', '{{.Id}}', inspected.Image), imageId)
    })

    await t.test('runs with NetworkMode none', () => {
      assert.equal(inspected.HostConfig.NetworkMode, 'none')
    })

    await t.test('has exactly one read-only snapshot bind and no app data mount', () => {
      assert.equal(inspected.Mounts.length, 1)
      assert.equal(inspected.Mounts[0].Type, 'bind')
      assert.equal(inspected.Mounts[0].Source, snapshot)
      assert.equal(inspected.Mounts[0].Destination, '/snap.db')
      assert.equal(inspected.Mounts[0].RW, false)
    })

    await t.test('uses a read-only root filesystem', () => {
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true)
    })

    await t.test('drops all Linux capabilities', () => {
      assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL'])
    })

    await t.test('sets no-new-privileges', () => {
      assert.ok(inspected.HostConfig.SecurityOpt?.includes('no-new-privileges'))
    })

    await t.test('runs Node as root only for the read-only snapshot', () => {
      assert.equal(inspected.Config.User, '0:0')
      assert.deepEqual(inspected.Config.Entrypoint, ['node'])
      assert.equal(inspected.Config.Cmd?.[0], '-e')
    })

    await t.test('inherits only the image baseline environment', () => {
      assert.deepEqual(inspected.Config.Env ?? [], imageEnv ?? [])
      const actual = inspected.Config.Env ?? []
      for (const [key, value] of Object.entries(SERVICE_ENV_SENTINELS)) {
        assert.ok(!actual.includes(`${key}=${value}`), `${key} service value leaked into validator`)
      }
    })

    await t.test('reads a real private SQLite snapshot', () => {
      assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600)
      assert.match(collected.stdout(), /XJM_VALIDATOR_SNAPSHOT_READ_OK/)
    })

    await t.test('does not change the host live database', () => {
      assert.equal(sha256(liveDb), liveShaBefore)
      assert.deepEqual(stableStat(liveDb), liveStatBefore)
    })

    mustDocker('kill', '--signal=USR2', validatorId)
    const result = await resultWithin(collected.result)
    assert.equal(result.code, 0, `validator failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.equal(result.signal, null)
    await waitUntil(() => docker('inspect', validatorId).status !== 0 ? true : undefined)
    assert.deepEqual(validatorContainersFor(snapshot), [])
  } finally {
    if (validatorId) docker('kill', '--signal=USR2', validatorId)
    await removeValidatorContainers(snapshot)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.race([collected.result.catch(() => undefined), delay(5_000)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('mutation removing network isolation is rejected and cleaned up', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-validator-mutant-')))
  const snapshot = path.join(root, 'snapshot.db')
  makeSqlite(snapshot, 'snapshot-readable')
  const imageId = imageIdForEquivalentRuntime()
  const original = validatorFunctions()
  const mutant = original.replace(/\n    --network none \\\n/, '\n')
  assert.notEqual(mutant, original, 'mutation did not remove --network none')

  try {
    const result = spawnSync(
      'sh',
      ['-c', shellHarness(mutant), 'restore-validator-mutant', imageId, snapshot, snapshotProbeScript()],
      {
        cwd: REPO,
        env: { ...process.env, ...SERVICE_ENV_SENTINELS },
        encoding: 'utf8',
        timeout: 20_000,
      },
    )
    assert.notEqual(result.status, 0, 'removing --network none must make the validator contract fail')
    assert.match(String(result.stderr || ''), /隔离属性|拒绝执行/)
    assert.deepEqual(validatorContainersFor(snapshot), [], 'rejected mutant must remove its container')
  } finally {
    await removeValidatorContainers(snapshot)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const validatorContractMutations: Array<{ label: string; mutate: (source: string) => string }> = [
  {
    label: 'read-only rootfs',
    mutate: (source) => source.replace(/\n    --read-only \\\n/, '\n'),
  },
  {
    label: 'cap-drop ALL',
    mutate: (source) => source.replace(/\n    --cap-drop ALL \\\n/, '\n'),
  },
  {
    label: 'no-new-privileges',
    mutate: (source) => source.replace(/\n    --security-opt no-new-privileges \\\n/, '\n'),
  },
  {
    label: 'root UID/GID',
    mutate: (source) => source.replace(/\n    --user 0:0 \\\n/, '\n'),
  },
  {
    label: 'explicit Node entrypoint',
    mutate: (source) => source.replace(/\n    --entrypoint node \\\n/, '\n'),
  },
  {
    label: 'read-only snapshot bind',
    mutate: (source) => source.replace('dst=/snap.db,readonly"', 'dst=/snap.db"'),
  },
  {
    label: 'single snapshot mount',
    mutate: (source) => source.replace(
      '    --mount "type=bind,src=$_validator_snapshot,dst=/snap.db,readonly" \\\n',
      '    --mount "type=bind,src=$_validator_snapshot,dst=/snap.db,readonly" \\\n' +
        '    --mount "type=bind,src=$_validator_snapshot,dst=/extra.db,readonly" \\\n',
    ),
  },
]

for (const mutation of validatorContractMutations) {
  test(`mutation removing ${mutation.label} is rejected before start and cleaned up`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-validator-mutant-')))
    const snapshot = path.join(root, 'snapshot.db')
    makeSqlite(snapshot, 'snapshot-readable')
    const imageId = imageIdForEquivalentRuntime()
    const original = validatorFunctions()
    const mutant = mutation.mutate(original)
    assert.notEqual(mutant, original, `${mutation.label} mutation did not change validator source`)

    try {
      const result = spawnSync(
        'sh',
        ['-c', shellHarness(mutant), 'restore-validator-mutant', imageId, snapshot, mutationProbeScript()],
        {
          cwd: REPO,
          env: { ...process.env, ...SERVICE_ENV_SENTINELS },
          encoding: 'utf8',
          timeout: 20_000,
        },
      )
      assert.notEqual(result.status, 0, `${mutation.label} must fail the isolation contract`)
      assert.match(String(result.stderr || ''), /隔离属性|拒绝执行/)
      assert.doesNotMatch(String(result.stdout || ''), /XJM_VALIDATOR_MUTANT_STARTED/)
      assert.deepEqual(validatorContainersFor(snapshot), [], `${mutation.label} mutant must remove its container`)
    } finally {
      await removeValidatorContainers(snapshot)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
