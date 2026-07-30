import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate } from '../lib/migrate.ts'

const root = path.resolve(import.meta.dirname, '..')

const SERVER_SOURCE = `
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.XJM_PROBE_ROOT
const toUrl = (relative) => pathToFileURL(path.join(root, relative)).href
const { register } = await import(toUrl('instrumentation.ts'))
await register()

const server = http.createServer(async (req, res) => {
  const route = req.url === '/api/health' ? 'app/api/health/route.ts' : req.url === '/api/ready' ? 'app/api/ready/route.ts' : null
  if (!route) {
    res.statusCode = 404
    res.end()
    return
  }
  try {
    const { GET } = await import(toUrl(route))
    const response = await GET()
    res.statusCode = response.status
    for (const [key, value] of response.headers) res.setHeader(key, value)
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: false, detail: error instanceof Error ? error.stack : String(error) }))
  }
})

server.listen(0, '127.0.0.1', () => {
  console.log('PORT=' + server.address().port)
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

function createDatabase(dbPath: string, broken = false): void {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  if (broken) db.exec('ALTER TABLE redeem_items RENAME TO __xjm_broken_redeem_items')
  db.close()
}

function spawnProbeServer(
  dbPath: string,
  options: {
    mock?: boolean
    workerEnabled?: boolean
    workerIntervalMs?: number
    mockCpaPath?: string
  } = {},
): Promise<{
  child: ChildProcessWithoutNullStreams
  baseUrl: string
  stop: () => Promise<void>
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-probe-server-'))
  const script = path.join(dir, 'server.mjs')
  fs.writeFileSync(script, SERVER_SOURCE)
  const child = spawn(process.execPath, ['--import', path.join(root, 'test/setup.mjs'), script], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
      MOCK: options.mock ? 'true' : 'false',
      WORKER_ENABLED: options.workerEnabled ? 'true' : 'false',
      WORKER_INTERVAL_MS: String(options.workerIntervalMs ?? 8000),
      DB_PATH: dbPath,
      MOCK_CPA_PATH: options.mockCpaPath ?? path.join(dir, 'mock-cpa.json'),
      SESSION_SECRET: 'x'.repeat(64),
      CPA_BASE_URL: 'https://example.invalid',
      CPA_MANAGEMENT_KEY: 'test-only-not-real',
      LINUXDO_CLIENT_ID: '',
      LINUXDO_CLIENT_SECRET: '',
      XJM_PROBE_ROOT: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  const hasExited = () => child.exitCode !== null || child.signalCode !== null
  let cleanupPromise: Promise<void> | undefined
  const waitForExit = async () => {
    if (hasExited()) return
    await Promise.race([
      once(child, 'exit'),
      new Promise<void>((resolve) => setTimeout(() => {
        if (!hasExited()) child.kill('SIGKILL')
        resolve()
      }, 1_000)),
    ])
  }
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      if (!hasExited()) child.kill('SIGTERM')
      await waitForExit()
      fs.rmSync(dir, { recursive: true, force: true })
    })()
    return cleanupPromise
  }

  let output = ''
  let errors = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { errors += chunk })

  const ready = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`probe server startup timeout\n${errors}`)), 10_000)
    const onOutput = (chunk: string) => {
      const match = chunk.match(/PORT=(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', onOutput)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`probe server exited before listen: code=${code} signal=${signal}\nstdout=${output}\nstderr=${errors}`))
    })
  })

  return ready.then((port) => ({
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: cleanup,
  })).catch(async (error) => {
    await cleanup()
    throw error
  })
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('production cold start keeps health live and returns sanitized ready 503 for a broken schema', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-probe-cold-'))
  const dbPath = path.join(dir, 'app.db')
  createDatabase(dbPath, true)
  let server: Awaited<ReturnType<typeof spawnProbeServer>> | undefined
  try {
    server = await spawnProbeServer(dbPath)
    const health = await fetch(`${server.baseUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const ready = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(ready.status, 503)
    const body = await ready.json()
    assert.deepEqual(body, {
      ok: false,
      code: 'DATABASE_NOT_READY',
      summary: '数据库尚未就绪',
    })
    for (const secret of [dbPath, 'redeem_items', 'SQLITE', 'stack']) {
      assert.equal(JSON.stringify(body).includes(secret), false)
    }

    const repair = new DatabaseSync(dbPath)
    try {
      repair.exec('ALTER TABLE __xjm_broken_redeem_items RENAME TO redeem_items')
    } finally {
      repair.close()
    }
    const recovered = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(recovered.status, 200)
    assert.deepEqual(await recovered.json(), { ok: true })
  } finally {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real HTTP readiness rejects an atomic same-schema replacement after opening the resident connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-probe-replaced-inode-'))
  const dbPath = path.join(dir, 'app.db')
  const replacementPath = path.join(dir, 'replacement.db')
  createDatabase(dbPath)
  let server: Awaited<ReturnType<typeof spawnProbeServer>> | undefined
  try {
    server = await spawnProbeServer(dbPath)
    const initial = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(initial.status, 200)
    assert.deepEqual(await initial.json(), { ok: true })

    const source = new DatabaseSync(dbPath)
    try {
      source.prepare('VACUUM INTO ?').run(replacementPath)
    } finally {
      source.close()
    }
    fs.renameSync(replacementPath, dbPath)

    const health = await fetch(`${server.baseUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const ready = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(ready.status, 503)
    assert.deepEqual(await ready.json(), {
      ok: false,
      code: 'DATABASE_NOT_READY',
      summary: '数据库尚未就绪',
    })
  } finally {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('enabled worker retries readiness and starts a real collect tick after a broken database is repaired', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-worker-recovery-'))
  const dbPath = path.join(dir, 'app.db')
  const mockCpaPath = path.join(dir, 'mock-cpa.json')
  const contributionId = 'worker-recovery-contribution'
  const accountId = 'worker-recovery-account'
  const authFileName = 'grok-worker-recovery.json'
  createDatabase(dbPath)
  const fixture = new DatabaseSync(dbPath)
  try {
    const now = Date.now()
    fixture.prepare(
      `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      contributionId,
      1,
      'worker-recovery',
      accountId,
      '',
      'grok',
      'super',
      'oauth',
      authFileName,
      'submitted',
      0,
      'none',
      '',
      '',
      null,
      now,
      now,
    )
    fixture.exec('ALTER TABLE redeem_items RENAME TO __xjm_broken_redeem_items')
  } finally {
    fixture.close()
  }
  fs.writeFileSync(mockCpaPath, JSON.stringify({
    [authFileName]: {
      name: authFileName,
      accountId,
      email: 'worker-recovery@example.com',
      plan: 'super',
      disabled: true,
      provider: 'grok',
    },
  }))

  let server: Awaited<ReturnType<typeof spawnProbeServer>> | undefined
  try {
    server = await spawnProbeServer(dbPath, {
      mock: true,
      workerEnabled: true,
      workerIntervalMs: 100,
      mockCpaPath,
    })
    const health = await fetch(`${server.baseUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })
    const brokenReady = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(brokenReady.status, 503)
    assert.deepEqual(await brokenReady.json(), {
      ok: false,
      code: 'DATABASE_NOT_READY',
      summary: '数据库尚未就绪',
    })

    // Let the first scheduled worker tick run against the broken schema. The worker must not
    // import/cache DB-backed collect or settle modules before the readiness gate succeeds.
    await wait(3_300)
    const beforeRepair = new DatabaseSync(dbPath)
    try {
      const row = beforeRepair.prepare(
        'SELECT verify_status AS status FROM contributions WHERE id=?',
      ).get(contributionId) as { status: string }
      assert.equal(row.status, 'submitted')
      beforeRepair.exec('ALTER TABLE __xjm_broken_redeem_items RENAME TO redeem_items')
    } finally {
      beforeRepair.close()
    }

    const recoveredReady = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(recoveredReady.status, 200)
    assert.deepEqual(await recoveredReady.json(), { ok: true })

    const deadline = Date.now() + 5_000
    let status = 'submitted'
    while (Date.now() < deadline) {
      const check = new DatabaseSync(dbPath)
      try {
        status = (check.prepare(
          'SELECT verify_status AS status FROM contributions WHERE id=?',
        ).get(contributionId) as { status: string }).status
      } finally {
        check.close()
      }
      if (status === 'pooled') break
      await wait(100)
    }
    assert.equal(status, 'pooled', '修库后无需重启，真实 worker tick 应完成 collect 入池')
  } finally {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real HTTP lock contention fails ready quickly while concurrent health stays live', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-probe-lock-'))
  const dbPath = path.join(dir, 'app.db')
  createDatabase(dbPath)
  let server: Awaited<ReturnType<typeof spawnProbeServer>> | undefined
  const lock = new DatabaseSync(dbPath)
  let lockHeld = false
  try {
    server = await spawnProbeServer(dbPath)
    const initial = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(initial.status, 200)

    lock.exec('PRAGMA busy_timeout = 0')
    lock.exec('BEGIN IMMEDIATE')
    lockHeld = true

    const readyStart = performance.now()
    const readyPromise = fetch(`${server.baseUrl}/api/ready`).then(async (response) => ({
      response,
      elapsed: performance.now() - readyStart,
      body: await response.json(),
    }))
    await wait(20)
    const healthStart = performance.now()
    const healthPromise = fetch(`${server.baseUrl}/api/health`).then(async (response) => ({
      response,
      elapsed: performance.now() - healthStart,
      body: await response.json(),
    }))
    const [ready, health] = await Promise.all([readyPromise, healthPromise])

    assert.equal(ready.response.status, 503)
    assert.deepEqual(ready.body, {
      ok: false,
      code: 'DATABASE_NOT_READY',
      summary: '数据库尚未就绪',
    })
    assert.equal(health.response.status, 200)
    assert.deepEqual(health.body, { ok: true })
    t.diagnostic(`ready=${ready.elapsed.toFixed(1)}ms health=${health.elapsed.toFixed(1)}ms`)
    assert.ok(ready.elapsed < 500, `ready lock probe took ${ready.elapsed.toFixed(1)}ms`)
    assert.ok(health.elapsed < 500, `health was blocked for ${health.elapsed.toFixed(1)}ms`)

    lock.exec('ROLLBACK')
    lockHeld = false
    const recovered = await fetch(`${server.baseUrl}/api/ready`)
    assert.equal(recovered.status, 200)
    const check = new DatabaseSync(dbPath)
    try {
      assert.equal((check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
      assert.deepEqual(check.prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE '__xjm_readiness_probe_%'",
      ).all(), [])
    } finally {
      check.close()
    }
  } finally {
    if (lockHeld) {
      try { lock.exec('ROLLBACK') } catch { /* lock may not have started */ }
    }
    lock.close()
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
