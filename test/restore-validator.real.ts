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
const RESTORE_SH = process.env.RESTORE_VALIDATOR_SCRIPT ?? path.join(REPO, 'scripts', 'restore.sh')
const SERVICE_ENV_SENTINELS = {
  SESSION_SECRET: 'xjm-real-validator-session-sentinel',
  CPA_API_KEY: 'xjm-real-validator-cpa-sentinel',
  TZ: 'Etc/GMT+12',
}

type DockerInspect = {
  Id: string
  Name: string
  Image: string
  State: { Running: boolean }
  Config: {
    Env: string[] | null
    User: string
    Entrypoint: string[] | null
    Cmd: string[] | null
    Labels: Record<string, string> | null
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

type WrapperMode =
  | 'normal'
  | 'create-lost-response'
  | 'create-invalid-stdout'
  | 'foreign-name-collision'
  | 'inspect-failure'
  | 'rm-failure'
  | 'rm-lost-response'

type WrapperState = {
  mode?: WrapperMode
  createAttempts?: number
  name?: string
  token?: string
  imageLabel?: string
  snapshotIdentity?: string
  mount?: string
  createdId?: string
  foreignId?: string
  inspectFailures?: number
  rmAttempts?: number
}

type DockerHarness = {
  wrapperDir: string
  stateFile: string
  env: NodeJS.ProcessEnv
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

function realDockerPath(): string {
  const result = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `docker CLI is required: ${result.stderr || ''}`)
  const resolved = String(result.stdout || '').trim()
  assert.ok(path.isAbsolute(resolved), `docker CLI path must be absolute: ${resolved}`)
  return fs.realpathSync(resolved)
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
    extractFunction(source, 'validator_clear_state'),
    extractFunction(source, 'validator_owned_container_id'),
    extractFunction(source, 'validator_reconcile_absent'),
    extractFunction(source, 'validator_cleanup_container'),
    extractFunction(source, 'validator_cleanup_pending_by_name'),
    extractFunction(source, 'node_with_snapshot'),
  ].join('\n\n')
}

function shellHarness(functions: string): string {
  return `set -eu
RESTORE_CONTAINER_IMAGE=$1
${functions}
validator_clear_state
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

function containerIdsForToken(token: string): string[] {
  assert.match(token, /^[0-9a-f]{64}$/, 'ownership token must be high entropy')
  const result = docker(
    'ps', '-aq', '--no-trunc',
    '--filter', `label=com.xiaojimao.restore.validator.token=${token}`,
  )
  assert.equal(result.status, 0, `cannot enumerate owned validator containers: ${result.stderr || ''}`)
  return String(result.stdout || '').trim().split('\n').filter(Boolean)
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

async function resultWithin(result: Promise<ChildResult>, timeoutMs = 10_000): Promise<ChildResult> {
  return Promise.race([
    result,
    delay(timeoutMs).then(() => assert.fail(`validator child did not exit within ${timeoutMs}ms`)),
  ])
}

function dockerWrapperSource(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const realDocker = process.env.XJM_REAL_DOCKER
const stateFile = process.env.XJM_DOCKER_WRAPPER_STATE
const mode = process.env.XJM_DOCKER_WRAPPER_MODE || 'normal'

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return {} }
}

function saveState(patch) {
  const next = { ...loadState(), mode, ...patch }
  const temporary = stateFile + '.tmp-' + process.pid
  fs.writeFileSync(temporary, JSON.stringify(next))
  fs.renameSync(temporary, stateFile)
  return next
}

function capture(command) {
  return spawnSync(realDocker, command, { encoding: 'utf8' })
}

function replay(result) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.status === null ? 125 : result.status)
}

function optionValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || '' : ''
}

function labelValue(name) {
  for (let index = 0; index < args.length; index += 1) {
    let value = ''
    if (args[index] === '--label') value = args[index + 1] || ''
    else if (args[index].startsWith('--label=')) value = args[index].slice('--label='.length)
    if (value.startsWith(name + '=')) return value.slice(name.length + 1)
  }
  return ''
}

function requestedReferenceMatches(state) {
  return args.some((arg) => arg === state.createdId || arg === state.name || arg === '/' + state.name)
}

if (args[0] === 'create') {
  const previous = loadState()
  const name = optionValue('--name')
  const token = labelValue('com.xiaojimao.restore.validator.token')
  const imageLabel = labelValue('com.xiaojimao.restore.validator.image')
  const snapshotIdentity = labelValue('com.xiaojimao.restore.validator.snapshot')
  const mount = optionValue('--mount')
  saveState({
    createAttempts: (previous.createAttempts || 0) + 1,
    name,
    token,
    imageLabel,
    snapshotIdentity,
    mount,
  })

  if (mode === 'foreign-name-collision') {
    const foreign = capture([
      'create', '--name', name,
      '--label', 'com.xiaojimao.restore.validator.foreign=v1',
      '--network', 'none', '--entrypoint', 'node',
      process.env.XJM_TEST_IMAGE_ID, '-e', 'process.exit(0)',
    ])
    const foreignId = String(foreign.stdout || '').trim()
    if (foreign.status !== 0 || !/^[0-9a-f]{64}$/.test(foreignId)) replay(foreign)
    saveState({ foreignId })
    replay(capture(args))
  }

  const created = capture(args)
  const createdId = String(created.stdout || '').trim()
  if (created.status === 0 && /^[0-9a-f]{64}$/.test(createdId)) saveState({ createdId })
  if (mode === 'create-lost-response' && created.status === 0) process.exit(97)
  if (mode === 'create-invalid-stdout' && created.status === 0) {
    process.stdout.write('not-a-container-id\\n')
    process.exit(0)
  }
  replay(created)
}

const state = loadState()
if (args[0] === 'inspect' && mode === 'inspect-failure' && requestedReferenceMatches(state)) {
  saveState({ inspectFailures: (state.inspectFailures || 0) + 1 })
  process.exit(97)
}

if (args[0] === 'rm' && requestedReferenceMatches(state)) {
  saveState({ rmAttempts: (state.rmAttempts || 0) + 1 })
  if (mode === 'rm-failure') process.exit(97)
  if (mode === 'rm-lost-response') {
    const removed = capture(args)
    if (removed.status !== 0) replay(removed)
    process.exit(97)
  }
}

const result = spawnSync(realDocker, args, { stdio: 'inherit' })
process.exit(result.status === null ? 125 : result.status)
`
}

function createDockerHarness(root: string, imageId: string, mode: WrapperMode): DockerHarness {
  const wrapperDir = path.join(root, 'docker-wrapper')
  const stateFile = path.join(root, 'docker-wrapper-state.json')
  fs.mkdirSync(wrapperDir, { mode: 0o700 })
  const wrapper = path.join(wrapperDir, 'docker')
  fs.writeFileSync(wrapper, dockerWrapperSource(), { mode: 0o700 })
  return {
    wrapperDir,
    stateFile,
    env: {
      ...process.env,
      ...SERVICE_ENV_SENTINELS,
      PATH: `${wrapperDir}:${process.env.PATH || ''}`,
      XJM_REAL_DOCKER: realDockerPath(),
      XJM_DOCKER_WRAPPER_STATE: stateFile,
      XJM_DOCKER_WRAPPER_MODE: mode,
      XJM_TEST_IMAGE_ID: imageId,
    },
  }
}

function readWrapperState(harness: DockerHarness): WrapperState {
  try {
    return JSON.parse(fs.readFileSync(harness.stateFile, 'utf8')) as WrapperState
  } catch {
    return {}
  }
}

function assertLiveDatabaseUnchanged(
  liveDb: string,
  shaBefore: string,
  statBefore: Record<string, string>,
): void {
  assert.equal(sha256(liveDb), shaBefore, 'validator must not change the live database bytes')
  assert.deepEqual(stableStat(liveDb), statBefore, 'validator must not change live database metadata')
}

async function assertOwnedContainerAbsent(state: WrapperState): Promise<void> {
  if (state.createdId) {
    await waitUntil(() => docker('inspect', state.createdId as string).status !== 0 ? true : undefined)
  }
  if (state.token) {
    await waitUntil(() => containerIdsForToken(state.token as string).length === 0 ? true : undefined)
  }
}

async function cleanupHarnessContainers(harness: DockerHarness): Promise<void> {
  const state = readWrapperState(harness)
  const exactIds = [state.createdId, state.foreignId].filter(
    (value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
  )
  for (const id of exactIds) docker('rm', '-f', id)
  if (state.token && /^[0-9a-f]{64}$/.test(state.token)) {
    for (const id of containerIdsForToken(state.token)) docker('rm', '-f', id)
  }
  for (const id of exactIds) {
    await waitUntil(() => docker('inspect', id).status !== 0 ? true : undefined)
  }
  if (state.token && /^[0-9a-f]{64}$/.test(state.token)) {
    await waitUntil(() => containerIdsForToken(state.token as string).length === 0 ? true : undefined)
  }
}

function makeFixture(prefix: string): {
  root: string
  snapshot: string
  liveDb: string
  liveShaBefore: string
  liveStatBefore: Record<string, string>
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const snapshot = path.join(root, 'snapshot.db')
  const liveDb = path.join(root, 'app.db')
  makeSqlite(snapshot, 'snapshot-readable')
  makeSqlite(liveDb, 'live-database-must-not-change')
  return {
    root,
    snapshot,
    liveDb,
    liveShaBefore: sha256(liveDb),
    liveStatBefore: stableStat(liveDb),
  }
}

function runHarnessSync(
  harness: DockerHarness,
  functions: string,
  imageId: string,
  snapshot: string,
  probe: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    'sh',
    ['-c', shellHarness(functions), 'restore-validator-real', imageId, snapshot, probe],
    { cwd: REPO, env: harness.env, encoding: 'utf8', timeout: 30_000 },
  )
}

test('real Docker snapshot validator enforces the isolated exact-image contract', async (t) => {
  const server = docker('version', '--format', '{{.Server.Version}}')
  assert.equal(server.status, 0, `Docker daemon is required: ${server.stderr || ''}`)

  const fixture = makeFixture('xjm-validator-real-')
  const imageId = imageIdForEquivalentRuntime()
  const imageEnv = JSON.parse(
    mustDocker('image', 'inspect', '--format', '{{json .Config.Env}}', imageId) || '[]',
  ) as string[] | null
  const harness = createDockerHarness(fixture.root, imageId, 'normal')
  const child = spawn(
    'sh',
    [
      '-c', shellHarness(validatorFunctions()), 'restore-validator-real',
      imageId, fixture.snapshot, snapshotProbeScript(),
    ],
    { cwd: REPO, env: harness.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const collected = collect(child)
  let validatorId = ''

  try {
    const state = await waitUntil(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.fail(
          `validator exited before inspection: code=${child.exitCode} signal=${child.signalCode}\n` +
          `stdout:\n${collected.stdout()}\nstderr:\n${collected.stderr()}`,
        )
      }
      const current = readWrapperState(harness)
      if (!current.createdId || !current.token) return undefined
      const inspected = inspectContainer(current.createdId)
      if (!inspected.State.Running) return undefined
      if (!collected.stdout().includes('XJM_VALIDATOR_SNAPSHOT_READ_OK')) return undefined
      return current
    })
    validatorId = state.createdId as string
    assert.deepEqual(containerIdsForToken(state.token as string), [validatorId])
    const inspected = inspectContainer(validatorId)

    await t.test('uses the verified exact image ID', () => {
      assert.equal(inspected.Image, imageId)
      assert.equal(mustDocker('image', 'inspect', '--format', '{{.Id}}', inspected.Image), imageId)
    })

    await t.test('uses high-entropy ownership labels bound to image and snapshot identity', () => {
      assert.match(state.name || '', /^xjm-restore-validator-[0-9a-f]{64}$/)
      assert.match(state.token || '', /^[0-9a-f]{64}$/)
      assert.equal(inspected.Name, `/${state.name}`)
      assert.equal(inspected.Config.Labels?.['com.xiaojimao.restore.validator'], 'v1')
      assert.equal(inspected.Config.Labels?.['com.xiaojimao.restore.validator.token'], state.token)
      assert.equal(inspected.Config.Labels?.['com.xiaojimao.restore.validator.image'], imageId)
      assert.equal(
        inspected.Config.Labels?.['com.xiaojimao.restore.validator.snapshot'],
        state.snapshotIdentity,
      )
    })

    await t.test('runs with NetworkMode none', () => {
      assert.equal(inspected.HostConfig.NetworkMode, 'none')
    })

    await t.test('has exactly one read-only snapshot bind and no app data mount', () => {
      assert.equal(inspected.Mounts.length, 1)
      assert.equal(inspected.Mounts[0].Type, 'bind')
      assert.equal(inspected.Mounts[0].Source, fixture.snapshot)
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

    await t.test('runs Node as the snapshot owner only for the read-only snapshot', () => {
      const snapshotStat = fs.statSync(fixture.snapshot)
      assert.equal(inspected.Config.User, `${snapshotStat.uid}:${snapshotStat.gid}`)
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
      assert.equal(fs.statSync(fixture.snapshot).mode & 0o777, 0o600)
      assert.match(collected.stdout(), /XJM_VALIDATOR_SNAPSHOT_READ_OK/)
    })

    await t.test('does not change the host live database', () => {
      assertLiveDatabaseUnchanged(
        fixture.liveDb,
        fixture.liveShaBefore,
        fixture.liveStatBefore,
      )
    })

    mustDocker('kill', '--signal=USR2', validatorId)
    const result = await resultWithin(collected.result)
    assert.equal(result.code, 0, `validator failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.equal(result.signal, null)
    await assertOwnedContainerAbsent(readWrapperState(harness))
  } finally {
    if (validatorId && docker('inspect', validatorId).status === 0) {
      docker('kill', '--signal=USR2', validatorId)
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.race([collected.result.catch(() => undefined), delay(5_000)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await cleanupHarnessContainers(harness)
    assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('mutation removing network isolation is rejected and cleaned up', async () => {
  const fixture = makeFixture('xjm-validator-mutant-')
  const imageId = imageIdForEquivalentRuntime()
  const harness = createDockerHarness(fixture.root, imageId, 'normal')
  const original = validatorFunctions()
  const mutant = original.replace(/\n    --network none \\\n/, '\n')
  assert.notEqual(mutant, original, 'mutation did not remove --network none')

  try {
    const result = runHarnessSync(harness, mutant, imageId, fixture.snapshot, snapshotProbeScript())
    assert.notEqual(result.status, 0, 'removing --network none must make the validator contract fail')
    assert.match(String(result.stderr || ''), /隔离属性|拒绝执行/)
    await assertOwnedContainerAbsent(readWrapperState(harness))
    assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
  } finally {
    await cleanupHarnessContainers(harness)
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

const validatorContractMutations: Array<{
  label: string
  ownershipInspectable?: boolean
  mutate: (source: string) => string
}> = [
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
    label: 'snapshot owner UID/GID',
    mutate: (source) => source.replace(/\n    --user "\$_validator_owner" \\\n/, '\n'),
  },
  {
    label: 'explicit Node entrypoint',
    mutate: (source) => source.replace(/\n    --entrypoint node \\\n/, '\n'),
  },
  {
    label: 'read-only snapshot bind',
    ownershipInspectable: false,
    mutate: (source) => source.replace('dst=/snap.db,readonly"', 'dst=/snap.db"'),
  },
  {
    label: 'single snapshot mount',
    ownershipInspectable: false,
    mutate: (source) => source.replace(
      '    --mount "type=bind,src=$_validator_snapshot,dst=/snap.db,readonly" \\\n',
      '    --mount "type=bind,src=$_validator_snapshot,dst=/snap.db,readonly" \\\n' +
        '    --mount "type=bind,src=$_validator_snapshot,dst=/extra.db,readonly" \\\n',
    ),
  },
]

for (const mutation of validatorContractMutations) {
  const cleanupExpectation = mutation.ownershipInspectable === false
    ? 'preserved for exact-ID teardown'
    : 'cleaned up'
  test(`mutation removing ${mutation.label} is rejected before start and ${cleanupExpectation}`, async () => {
    const fixture = makeFixture('xjm-validator-mutant-')
    const imageId = imageIdForEquivalentRuntime()
    const harness = createDockerHarness(fixture.root, imageId, 'normal')
    const original = validatorFunctions()
    const mutant = mutation.mutate(original)
    assert.notEqual(mutant, original, `${mutation.label} mutation did not change validator source`)

    try {
      const result = runHarnessSync(harness, mutant, imageId, fixture.snapshot, mutationProbeScript())
      assert.notEqual(result.status, 0, `${mutation.label} must fail the isolation contract`)
      assert.doesNotMatch(String(result.stdout || ''), /XJM_VALIDATOR_MUTANT_STARTED/)
      const state = readWrapperState(harness)
      if (mutation.ownershipInspectable === false) {
        assert.match(String(result.stderr || ''), /返回 ID 未通过|exact name 无法证明 ownership/)
        assert.match(state.createdId || '', /^[0-9a-f]{64}$/)
        assert.equal(state.rmAttempts, undefined)
        assert.equal(docker('inspect', state.createdId as string).status, 0)
        assert.deepEqual(containerIdsForToken(state.token as string), [state.createdId])
      } else {
        assert.match(String(result.stderr || ''), /隔离属性|拒绝执行/)
        await assertOwnedContainerAbsent(state)
      }
      assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
    } finally {
      await cleanupHarnessContainers(harness)
      await assertOwnedContainerAbsent(readWrapperState(harness))
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}

const createAmbiguityScenarios: Array<{
  label: string
  mode: 'create-lost-response' | 'create-invalid-stdout'
}> = [
  { label: 'create succeeds but the CLI response is lost', mode: 'create-lost-response' },
  { label: 'create succeeds but stdout is not a container ID', mode: 'create-invalid-stdout' },
]

for (const scenario of createAmbiguityScenarios) {
  test(`real Docker ${scenario.label} is reconciled by exact ownership and removed`, async () => {
    const fixture = makeFixture('xjm-validator-create-ambiguous-')
    const imageId = imageIdForEquivalentRuntime()
    const harness = createDockerHarness(fixture.root, imageId, scenario.mode)

    try {
      const result = runHarnessSync(
        harness,
        validatorFunctions(),
        imageId,
        fixture.snapshot,
        mutationProbeScript(),
      )
      assert.notEqual(result.status, 0, 'ambiguous create response must fail closed')
      assert.match(String(result.stderr || ''), /create 响应失败或缺失\/异常/)
      const state = readWrapperState(harness)
      assert.match(state.createdId || '', /^[0-9a-f]{64}$/)
      assert.match(state.token || '', /^[0-9a-f]{64}$/)
      assert.match(state.name || '', /^xjm-restore-validator-[0-9a-f]{64}$/)
      assert.equal(state.rmAttempts, 1)
      await assertOwnedContainerAbsent(state)
      assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
    } finally {
      await cleanupHarnessContainers(harness)
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}

test('real Docker foreign exact-name collision is not deleted without matching ownership labels', async () => {
  const fixture = makeFixture('xjm-validator-foreign-collision-')
  const imageId = imageIdForEquivalentRuntime()
  const harness = createDockerHarness(fixture.root, imageId, 'foreign-name-collision')

  try {
    const result = runHarnessSync(
      harness,
      validatorFunctions(),
      imageId,
      fixture.snapshot,
      mutationProbeScript(),
    )
    assert.notEqual(result.status, 0, 'foreign name collision must fail closed')
    assert.match(String(result.stderr || ''), /exact name 无法证明 ownership/)
    const state = readWrapperState(harness)
    assert.equal(state.createdId, undefined)
    assert.match(state.foreignId || '', /^[0-9a-f]{64}$/)
    assert.match(state.token || '', /^[0-9a-f]{64}$/)
    const foreign = inspectContainer(state.foreignId as string)
    assert.equal(foreign.Name, `/${state.name}`)
    assert.equal(foreign.Config.Labels?.['com.xiaojimao.restore.validator.foreign'], 'v1')
    assert.equal(foreign.Config.Labels?.['com.xiaojimao.restore.validator.token'], undefined)
    assert.deepEqual(containerIdsForToken(state.token as string), [])
    assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
  } finally {
    await cleanupHarnessContainers(harness)
    const finalState = readWrapperState(harness)
    if (finalState.foreignId) {
      assert.notEqual(docker('inspect', finalState.foreignId).status, 0)
    }
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('real Docker inspect failure preserves the unproven container for exact-ID teardown', async () => {
  const fixture = makeFixture('xjm-validator-inspect-failure-')
  const imageId = imageIdForEquivalentRuntime()
  const harness = createDockerHarness(fixture.root, imageId, 'inspect-failure')

  try {
    const result = runHarnessSync(
      harness,
      validatorFunctions(),
      imageId,
      fixture.snapshot,
      mutationProbeScript(),
    )
    assert.notEqual(result.status, 0, 'inspect ambiguity must fail closed')
    assert.match(String(result.stderr || ''), /exact name 无法证明 ownership/)
    const state = readWrapperState(harness)
    assert.match(state.createdId || '', /^[0-9a-f]{64}$/)
    assert.ok((state.inspectFailures || 0) >= 2)
    assert.equal(state.rmAttempts, undefined)
    assert.equal(docker('inspect', state.createdId as string).status, 0)
    assert.deepEqual(containerIdsForToken(state.token as string), [state.createdId])
    assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
  } finally {
    await cleanupHarnessContainers(harness)
    await assertOwnedContainerAbsent(readWrapperState(harness))
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('real Docker rm failure leaves the owned container visible and fails closed', async () => {
  const fixture = makeFixture('xjm-validator-rm-failure-')
  const imageId = imageIdForEquivalentRuntime()
  const harness = createDockerHarness(fixture.root, imageId, 'rm-failure')

  try {
    const result = runHarnessSync(
      harness,
      validatorFunctions(),
      imageId,
      fixture.snapshot,
      mutationProbeScript(),
    )
    assert.notEqual(result.status, 0, 'rm failure with a remaining owned container must fail closed')
    assert.match(String(result.stderr || ''), /无法清理快照校验容器/)
    assert.match(String(result.stdout || ''), /XJM_VALIDATOR_MUTANT_STARTED/)
    const state = readWrapperState(harness)
    assert.equal(state.rmAttempts, 1)
    assert.equal(docker('inspect', state.createdId as string).status, 0)
    assert.deepEqual(containerIdsForToken(state.token as string), [state.createdId])
    assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
  } finally {
    await cleanupHarnessContainers(harness)
    await assertOwnedContainerAbsent(readWrapperState(harness))
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('real Docker rm that succeeds but loses its response reconciles absence by ownership token', async () => {
  const fixture = makeFixture('xjm-validator-rm-lost-response-')
  const imageId = imageIdForEquivalentRuntime()
  const harness = createDockerHarness(fixture.root, imageId, 'rm-lost-response')

  try {
    const result = runHarnessSync(
      harness,
      validatorFunctions(),
      imageId,
      fixture.snapshot,
      mutationProbeScript(),
    )
    assert.equal(
      result.status,
      0,
      `lost rm response after deletion should reconcile cleanly\nstdout:\n${result.stdout || ''}\n` +
      `stderr:\n${result.stderr || ''}`,
    )
    assert.match(String(result.stdout || ''), /XJM_VALIDATOR_MUTANT_STARTED/)
    const state = readWrapperState(harness)
    assert.equal(state.rmAttempts, 1)
    await assertOwnedContainerAbsent(state)
    assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
  } finally {
    await cleanupHarnessContainers(harness)
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('mutation removing the ownership-token label cannot claim or delete the created container', async () => {
  const fixture = makeFixture('xjm-validator-label-mutation-')
  const imageId = imageIdForEquivalentRuntime()
  const harness = createDockerHarness(fixture.root, imageId, 'normal')
  const original = validatorFunctions()
  const mutant = original.replace(
    '    --label "com.xiaojimao.restore.validator.token=$_validator_token" \\\n',
    '',
  )
  assert.notEqual(mutant, original, 'ownership-token label mutation did not change validator source')

  try {
    const result = runHarnessSync(harness, mutant, imageId, fixture.snapshot, mutationProbeScript())
    assert.notEqual(result.status, 0, 'missing ownership label must fail closed')
    assert.match(String(result.stderr || ''), /exact name 无法证明 ownership/)
    const state = readWrapperState(harness)
    assert.equal(state.token, '')
    assert.match(state.createdId || '', /^[0-9a-f]{64}$/)
    assert.equal(state.rmAttempts, undefined)
    assert.equal(docker('inspect', state.createdId as string).status, 0)
    assertLiveDatabaseUnchanged(fixture.liveDb, fixture.liveShaBefore, fixture.liveStatBefore)
  } finally {
    await cleanupHarnessContainers(harness)
    const finalState = readWrapperState(harness)
    if (finalState.createdId) {
      assert.notEqual(docker('inspect', finalState.createdId).status, 0)
    }
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})
