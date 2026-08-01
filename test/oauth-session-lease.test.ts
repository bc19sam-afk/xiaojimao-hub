import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations } from '../lib/migrate.ts'
import type { CpaClient, ProviderId, StartResult } from '../lib/cpa.ts'
import type { SessionUser } from '../lib/session.ts'

let db: typeof import('../lib/db.ts').db
let collect: typeof import('../lib/collect.ts')
let cpa: CpaClient
let maxOAuthFinishDurationMs: number
let tmpDir: string
let dbPath: string
let originalCpa: Pick<CpaClient, 'startOAuth' | 'finishOAuth' | 'checkOAuth' | 'listAuthFiles'>

function user(id: number): SessionUser {
  return { id, username: `u${id}`, trustLevel: 3 }
}

function rawDb(): DatabaseSync {
  const raw = new DatabaseSync(dbPath)
  raw.exec('PRAGMA busy_timeout = 5000')
  return raw
}

function clearOAuthState(): void {
  const raw = rawDb()
  try {
    raw.exec('BEGIN IMMEDIATE')
    raw.exec('DELETE FROM oauth_snapshots; DELETE FROM oauth_provider_leases; DELETE FROM contributions;')
    raw.exec('COMMIT')
  } catch (error) {
    raw.exec('ROLLBACK')
    throw error
  } finally {
    raw.close()
  }
}

function seedSession(
  linuxdoId: number,
  provider: ProviderId,
  state: string,
  fileNames: string[] = [],
  now = Date.now(),
  expiresAt = now + 60_000,
): string {
  const leaseToken = `lease-${state}-${linuxdoId}`
  assert.equal(db.acquireOAuthProviderLease({ provider, linuxdoId, leaseToken, now, expiresAt }), true)
  assert.equal(
    db.createOAuthSession({
      state,
      fileNames,
      linuxdoId,
      provider,
      leaseToken,
      createdAt: now,
      expiresAt,
    }),
    true,
  )
  return leaseToken
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test barrier timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-oauth-lease-'))
  dbPath = path.join(tmpDir, 'app.db')
  process.env.MOCK = 'true'
  process.env.DB_PATH = dbPath
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  collect = await import('../lib/collect.ts')
  const cpaModule = await import('../lib/cpa.ts')
  cpa = cpaModule.cpa
  maxOAuthFinishDurationMs = cpaModule.MAX_OAUTH_FINISH_DURATION_MS
  db.getOAuthSnapshot('bootstrap') // force lazy openDb() so MOCK migration finishes before raw cleanup connections
  originalCpa = {
    startOAuth: cpa.startOAuth,
    finishOAuth: cpa.finishOAuth,
    checkOAuth: cpa.checkOAuth,
    listAuthFiles: cpa.listAuthFiles,
  }
})

beforeEach(() => {
  clearOAuthState()
})

afterEach(() => {
  cpa.startOAuth = originalCpa.startOAuth
  cpa.finishOAuth = originalCpa.finishOAuth
  cpa.checkOAuth = originalCpa.checkOAuth
  cpa.listAuthFiles = originalCpa.listAuthFiles
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('migration 014 adds owned OAuth session fields and persistent provider leases; legacy rows stay invalid', () => {
  assert.ok(migrations.some((entry) => entry.version === 14), '应存在 migration 014')
  const d = new DatabaseSync(':memory:')
  for (const migration of migrations.filter((entry) => entry.version <= 13).sort((a, b) => a.version - b.version)) {
    migration.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (13)').run()
  d.prepare('INSERT INTO oauth_snapshots (state, file_names, created_at) VALUES (?,?,?)').run(
    'legacy-state',
    '[]',
    Date.now(),
  )

  assert.equal(migrate(d), 14)
  const columns = d.prepare('PRAGMA table_info(oauth_snapshots)').all() as Array<{ name: string }>
  assert.deepEqual(columns.map((column) => column.name), [
    'state',
    'file_names',
    'created_at',
    'linuxdo_id',
    'provider',
    'expires_at',
    'lease_token',
    'operation_token',
    'operation_expires_at',
  ])
  assert.deepEqual(
    (d.prepare('PRAGMA table_info(oauth_provider_leases)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
    ['provider', 'lease_token', 'linuxdo_id', 'created_at', 'expires_at'],
  )
  const legacy = d.prepare(
    `SELECT linuxdo_id, provider, expires_at, lease_token
     FROM oauth_snapshots WHERE state='legacy-state'`,
  ).get() as { linuxdo_id: null; provider: null; expires_at: null; lease_token: null }
  assert.deepEqual({ ...legacy }, {
    linuxdo_id: null,
    provider: null,
    expires_at: null,
    lease_token: null,
  })
  d.close()
})

test('provider lease serializes one provider, allows different providers, expires, and fences stale release', () => {
  assert.equal(
    db.acquireOAuthProviderLease({ provider: 'codex', linuxdoId: 1, leaseToken: 'old', now: 100, expiresAt: 150 }),
    true,
  )
  assert.equal(
    db.acquireOAuthProviderLease({ provider: 'codex', linuxdoId: 2, leaseToken: 'blocked', now: 120, expiresAt: 170 }),
    false,
  )
  assert.equal(
    db.acquireOAuthProviderLease({ provider: 'claude', linuxdoId: 2, leaseToken: 'parallel', now: 120, expiresAt: 170 }),
    true,
  )
  assert.equal(
    db.acquireOAuthProviderLease({ provider: 'codex', linuxdoId: 3, leaseToken: 'new', now: 151, expiresAt: 220 }),
    true,
  )
  assert.equal(db.releaseOAuthProviderLease('codex', 'old'), false)
  assert.equal(
    db.acquireOAuthProviderLease({ provider: 'codex', linuxdoId: 4, leaseToken: 'should-stay-blocked', now: 152, expiresAt: 230 }),
    false,
  )
})

test('operation claim covers the bounded CPA flow and extends the provider lease through its fencing window', () => {
  assert.ok(
    collect.OAUTH_OPERATION_TTL_MS > maxOAuthFinishDurationMs + 15_000,
    'operation TTL 必须覆盖 redirect finish 最坏时长、后续 isolate timeout 及余量',
  )
  const leaseToken = seedSession(5, 'codex', 'extended-operation', [], 100, 150)
  const claim = db.claimOAuthSession({
    state: 'extended-operation',
    provider: 'codex',
    linuxdoId: 5,
    operationToken: 'extended-operation-token',
    now: 110,
    operationExpiresAt: 500,
  })
  assert.equal(claim.status, 'claimed')
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex', linuxdoId: 6, leaseToken: 'must-stay-blocked', now: 151, expiresAt: 600,
    }),
    false,
    '活跃 operation 期间不得因原 session TTL 到点而让同 provider 新会话闯入',
  )
  assert.equal(db.completeOAuthSession('extended-operation', leaseToken, 'extended-operation-token'), true)
})

test('start acquires the provider lease before CPA, blocks same provider, allows another provider, and snapshots before start', async () => {
  const events: string[] = []
  let releaseCodex!: (value: StartResult) => void
  const codexBarrier = new Promise<StartResult>((resolve) => {
    releaseCodex = resolve
  })
  cpa.listAuthFiles = async () => {
    events.push('list')
    return []
  }
  cpa.startOAuth = async (provider) => {
    events.push(`start:${provider}`)
    if (provider === 'codex') return codexBarrier
    return { state: 'claude-state', url: 'https://example.test/claude', flow: 'redirect' }
  }

  const first = collect.startOAuth(user(11), 'codex')
  await waitUntil(() => events.includes('start:codex'))
  await assert.rejects(() => collect.startOAuth(user(12), 'codex'), /已有授权|正在进行/)
  const parallel = await collect.startOAuth(user(12), 'claude')
  assert.equal(parallel.state, 'claude-state')
  assert.deepEqual(events.slice(0, 2), ['list', 'start:codex'])
  assert.equal(events.filter((event) => event === 'start:codex').length, 1)

  releaseCodex({ state: 'codex-state', url: 'https://example.test/codex', flow: 'redirect' })
  assert.equal((await first).state, 'codex-state')
  assert.deepEqual(db.getOAuthSnapshot('codex-state'), [])
  assert.deepEqual(db.getOAuthSnapshot('claude-state'), [])
})

test('start failure releases its lease so a retry can acquire the same provider', async () => {
  cpa.listAuthFiles = async () => []
  cpa.startOAuth = async () => {
    throw new Error('start failed')
  }
  await assert.rejects(() => collect.startOAuth(user(21), 'grok'), /start failed/)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 22,
      leaseToken: 'retry-after-failure',
      now: Date.now(),
      expiresAt: Date.now() + 60_000,
    }),
    true,
  )
})

test('snapshot list failure stops before CPA OAuth start and releases the provider lease', async () => {
  let startCalls = 0
  cpa.listAuthFiles = async () => {
    throw new Error('snapshot unavailable')
  }
  cpa.startOAuth = async () => {
    startCalls++
    return { state: 'must-not-start', url: 'https://example.test', flow: 'redirect' }
  }
  await assert.rejects(() => collect.startOAuth(user(23), 'codex'), /snapshot unavailable/)
  assert.equal(startCalls, 0)
  const now = Date.now()
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex', linuxdoId: 24, leaseToken: 'after-snapshot-failure', now, expiresAt: now + 60_000,
    }),
    true,
  )
})

test('wrong user, wrong provider, expired session, and legacy session never touch CPA', async () => {
  let touched = 0
  cpa.finishOAuth = async () => {
    touched++
    throw new Error('must not be called')
  }
  seedSession(31, 'claude', 'owned-state')
  const wrongUser = await collect.finishOAuth(user(32), 'claude', 'https://app.test/callback?state=owned-state')
  assert.equal(wrongUser.ok, false)
  const wrongProvider = await collect.finishOAuth(user(31), 'codex', 'https://app.test/callback?state=owned-state')
  assert.equal(wrongProvider.ok, false)

  const oldNow = Date.now() - 2_000
  seedSession(31, 'grok', 'expired-state', [], oldNow, oldNow + 1_000)
  const expired = await collect.finishOAuth(user(31), 'grok', 'https://app.test/callback?state=expired-state')
  assert.equal(expired.ok, false)

  const raw = rawDb()
  raw.prepare('INSERT INTO oauth_snapshots (state, file_names, created_at) VALUES (?,?,?)').run(
    'legacy-state',
    '[]',
    Date.now(),
  )
  raw.close()
  const legacy = await collect.finishOAuth(user(31), 'claude', 'https://app.test/callback?state=legacy-state')
  assert.equal(legacy.ok, false)
  assert.equal(touched, 0)
})

test('overlapping check is fenced; wait releases only operation; terminal error releases session and provider lease', async () => {
  seedSession(41, 'grok', 'device-state', ['existing.json'])
  let calls = 0
  let releaseCheck!: () => void
  const barrier = new Promise<void>((resolve) => {
    releaseCheck = resolve
  })
  cpa.checkOAuth = async () => {
    calls++
    await barrier
    return { status: 'wait' }
  }

  const first = collect.checkOAuth(user(41), 'grok', 'device-state')
  await waitUntil(() => calls === 1)
  const overlap = await collect.checkOAuth(user(41), 'grok', 'device-state')
  assert.equal(overlap.done, false)
  if (!overlap.done) assert.match(overlap.error ?? '', /处理中|稍后/)
  assert.equal(calls, 1)
  releaseCheck()
  assert.deepEqual(await first, { done: false })
  assert.deepEqual(db.getOAuthSnapshot('device-state'), ['existing.json'])

  cpa.checkOAuth = async () => ({ status: 'error', error: '授权失败' })
  const terminal = await collect.checkOAuth(user(41), 'grok', 'device-state')
  assert.deepEqual(terminal, { done: true, result: { ok: false, error: '授权失败' } })
  assert.equal(db.getOAuthSnapshot('device-state'), null)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 42,
      leaseToken: 'after-terminal',
      now: Date.now(),
      expiresAt: Date.now() + 60_000,
    }),
    true,
  )
})

test('finish transient failure keeps the session for retry; terminal-tagged failure releases it', async () => {
  seedSession(51, 'claude', 'retry-state')
  cpa.finishOAuth = async () => {
    throw new Error('temporary transport failure')
  }
  await assert.rejects(
    () => collect.finishOAuth(user(51), 'claude', 'https://app.test/callback?state=retry-state'),
    /temporary transport failure/,
  )
  assert.deepEqual(db.getOAuthSnapshot('retry-state'), [])

  cpa.finishOAuth = async () => ({
    accountId: 'retry-account',
    email: '',
    plan: 'pro',
    authFileName: '',
    duplicate: false,
  })
  const retry = await collect.finishOAuth(user(51), 'claude', 'https://app.test/callback?state=retry-state')
  assert.equal(retry.ok, true)
  assert.equal(db.getOAuthSnapshot('retry-state'), null)

  seedSession(52, 'codex', 'terminal-state')
  cpa.finishOAuth = async () => {
    throw Object.assign(new Error('terminal oauth failure'), { oauthTerminal: true })
  }
  await assert.rejects(
    () => collect.finishOAuth(user(52), 'codex', 'https://app.test/callback?state=terminal-state'),
    /terminal oauth failure/,
  )
  assert.equal(db.getOAuthSnapshot('terminal-state'), null)
})

test('auth-file 尚未可见时 redirect/device 都保留会话，下一次可认出后完成', async () => {
  seedSession(55, 'claude', 'late-redirect')
  let finishCalls = 0
  cpa.finishOAuth = async () => {
    finishCalls++
    if (finishCalls === 1) {
      return { accountId: '', email: '', plan: 'unknown', authFileName: '', duplicate: true }
    }
    return {
      accountId: 'late-redirect-account',
      email: '',
      plan: 'pro',
      authFileName: 'anthropic-late.json',
      duplicate: false,
    }
  }
  const redirectFirst = await collect.finishOAuth(
    user(55),
    'claude',
    'https://app.test/callback?state=late-redirect',
  )
  assert.equal(redirectFirst.ok, false)
  assert.deepEqual(db.getOAuthSnapshot('late-redirect'), [])
  const redirectSecond = await collect.finishOAuth(
    user(55),
    'claude',
    'https://app.test/callback?state=late-redirect',
  )
  assert.equal(redirectSecond.ok, true)
  assert.equal(db.getOAuthSnapshot('late-redirect'), null)

  seedSession(56, 'grok', 'late-device')
  let checkCalls = 0
  cpa.checkOAuth = async () => {
    checkCalls++
    if (checkCalls === 1) {
      return {
        status: 'ok',
        ingest: { accountId: '', email: '', plan: 'unknown', authFileName: '', duplicate: true },
      }
    }
    return {
      status: 'ok',
      ingest: {
        accountId: 'late-device-account',
        email: '',
        plan: 'super',
        authFileName: 'xai-late.json',
        duplicate: false,
      },
    }
  }
  const deviceFirst = await collect.checkOAuth(user(56), 'grok', 'late-device')
  assert.equal(deviceFirst.done, false)
  assert.deepEqual(db.getOAuthSnapshot('late-device'), [])
  const deviceSecond = await collect.checkOAuth(user(56), 'grok', 'late-device')
  assert.equal(deviceSecond.done, true)
  assert.equal(db.getOAuthSnapshot('late-device'), null)
})

test('stale operation and lease tokens cannot release a replacement session with the same state', () => {
  const oldLease = seedSession(61, 'codex', 'reused-state', [], 100, 150)
  const oldClaim = db.claimOAuthSession({
    state: 'reused-state',
    provider: 'codex',
    linuxdoId: 61,
    operationToken: 'old-operation',
    now: 110,
    operationExpiresAt: 140,
  })
  assert.equal(oldClaim.status, 'claimed')
  db.cleanupOAuthSessions(151)

  const newLease = seedSession(62, 'codex', 'reused-state', ['new.json'], 151, 250)
  const newClaim = db.claimOAuthSession({
    state: 'reused-state',
    provider: 'codex',
    linuxdoId: 62,
    operationToken: 'new-operation',
    now: 152,
    operationExpiresAt: 200,
  })
  assert.equal(newClaim.status, 'claimed')
  assert.equal(db.completeOAuthSession('reused-state', oldLease, 'old-operation'), false)
  assert.equal(db.releaseOAuthProviderLease('codex', oldLease), false)
  assert.deepEqual(db.getOAuthSnapshot('reused-state'), ['new.json'])
  assert.notEqual(oldLease, newLease)
})
