import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations } from '../lib/migrate.ts'
import type { CpaClient, ProviderId, StartResult } from '../lib/cpa.ts'
import type { Contribution } from '../lib/db.ts'
import type { SessionUser } from '../lib/session.ts'

let db: typeof import('../lib/db.ts').db
let collect: typeof import('../lib/collect.ts')
let cpa: CpaClient
let maxOAuthFinishDurationMs: number
let cpaUnavailable: string
let AuthFileUploadOutcomeUnknownError: typeof import('../lib/cpa.ts').AuthFileUploadOutcomeUnknownError
let tmpDir: string
let dbPath: string
let originalCpa: Pick<
  CpaClient,
  'startOAuth' | 'finishOAuth' | 'checkOAuth' | 'cancelOAuth' | 'ingestRefreshToken' | 'listAuthFiles' | 'setDisabled'
>

function user(id: number): SessionUser {
  return { id, username: `u${id}`, trustLevel: 3 }
}

function oauthContribution(
  linuxdoId: number,
  provider: ProviderId,
  accountId: string,
): Contribution {
  const now = Date.now()
  return {
    id: `contribution-${accountId}`,
    linuxdoId,
    username: `u${linuxdoId}`,
    accountId,
    email: '',
    provider,
    plan: 'pro',
    method: 'oauth',
    authFileName: `${provider}-${accountId}.json`,
    verifyStatus: 'submitted',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
  }
}

function rtContribution(linuxdoId: number, accountId: string): Contribution {
  return {
    ...oauthContribution(linuxdoId, 'codex', accountId),
    method: 'rt',
  }
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
  expiresAt = now + 900_000,
  hardExpiresAt = expiresAt,
): string {
  const leaseToken = `lease-${state}-${linuxdoId}`
  assert.equal(
    db.acquireOAuthProviderLease({ provider, linuxdoId, leaseToken, now, expiresAt: hardExpiresAt }),
    true,
  )
  assert.equal(
    db.createOAuthSession({
      state,
      fileNames,
      linuxdoId,
      provider,
      leaseToken,
      createdAt: now,
      expiresAt,
      hardExpiresAt,
      authorizationUrl: `https://example.test/${state}`,
      flow: 'redirect',
    }),
    true,
  )
  return leaseToken
}

function markModernSession(
  state: string,
  flow: 'redirect' | 'device',
  hardExpiresAt: number,
  url = `https://example.test/${state}`,
  userCode?: string,
): void {
  const raw = rawDb()
  raw.prepare(
    `UPDATE oauth_snapshots
     SET authorization_url=?, flow=?, user_code=?, status='ACTIVE', hard_expires_at=?
     WHERE state=?`,
  ).run(url, flow, userCode ?? null, hardExpiresAt, state)
  raw.close()
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
  cpaUnavailable = cpaModule.CPA_UNAVAILABLE
  AuthFileUploadOutcomeUnknownError = cpaModule.AuthFileUploadOutcomeUnknownError
  db.getOAuthSnapshot('bootstrap') // force lazy openDb() so MOCK migration finishes before raw cleanup connections
  originalCpa = {
    startOAuth: cpa.startOAuth,
    finishOAuth: cpa.finishOAuth,
    checkOAuth: cpa.checkOAuth,
    cancelOAuth: cpa.cancelOAuth,
    ingestRefreshToken: cpa.ingestRefreshToken,
    listAuthFiles: cpa.listAuthFiles,
    setDisabled: cpa.setDisabled,
  }
})

beforeEach(() => {
  clearOAuthState()
})

afterEach(() => {
  cpa.startOAuth = originalCpa.startOAuth
  cpa.finishOAuth = originalCpa.finishOAuth
  cpa.checkOAuth = originalCpa.checkOAuth
  cpa.cancelOAuth = originalCpa.cancelOAuth
  cpa.ingestRefreshToken = originalCpa.ingestRefreshToken
  cpa.listAuthFiles = originalCpa.listAuthFiles
  cpa.setDisabled = originalCpa.setDisabled
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('migration 015 adds recoverable OAuth metadata and an explicit fenced lifecycle; legacy rows stay invalid', () => {
  assert.ok(migrations.some((entry) => entry.version === 15), '应存在 migration 015')
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

  assert.equal(migrate(d), 15)
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
    'authorization_url',
    'flow',
    'user_code',
    'status',
    'hard_expires_at',
    'cancelled_at',
  ])
  assert.deepEqual(
    (d.prepare('PRAGMA table_info(oauth_provider_leases)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
    ['provider', 'lease_token', 'linuxdo_id', 'created_at', 'expires_at'],
  )
  const legacy = d.prepare(
    `SELECT linuxdo_id, provider, expires_at, lease_token, status, hard_expires_at
     FROM oauth_snapshots WHERE state='legacy-state'`,
  ).get() as {
    linuxdo_id: null
    provider: null
    expires_at: null
    lease_token: null
    status: null
    hard_expires_at: null
  }
  assert.deepEqual({ ...legacy }, {
    linuxdo_id: null,
    provider: null,
    expires_at: null,
    lease_token: null,
    status: null,
    hard_expires_at: null,
  })
  d.close()
})

test('same owner and provider recovers the persisted start result without calling CPA again', async () => {
  let startCalls = 0
  cpa.listAuthFiles = async () => []
  cpa.startOAuth = async () => {
    startCalls++
    return {
      state: 'recover-state',
      url: 'https://example.test/recover',
      flow: 'device',
      userCode: 'ABCD-EFGH',
      expiresIn: 1800,
    }
  }

  const first = await collect.startOAuth(user(7), 'grok')
  const recovered = await collect.startOAuth(user(7), 'grok')

  assert.deepEqual(recovered, first)
  assert.equal(startCalls, 1)
  assert.equal('leaseToken' in recovered, false)
  assert.equal('operationToken' in recovered, false)
  const raw = rawDb()
  const row = raw.prepare(
    `SELECT created_at AS createdAt, expires_at AS expiresAt, hard_expires_at AS hardExpiresAt
     FROM oauth_snapshots WHERE state='recover-state'`,
  ).get() as { createdAt: number; expiresAt: number; hardExpiresAt: number }
  raw.close()
  assert.equal(first.expiresAt, row.expiresAt)
  assert.equal(recovered.expiresAt, row.expiresAt)
  assert.equal(row.expiresAt - row.createdAt, 1_800_000)
  assert.equal(row.hardExpiresAt - row.expiresAt, collect.OAUTH_OPERATION_TTL_MS)
})

test('same owner can recover a session while another request holds CLAIMED; it remains fenced and retryable', async () => {
  const now = Date.now()
  const leaseToken = seedSession(8, 'grok', 'reload-claimed', [], now, now + 900_000)
  markModernSession('reload-claimed', 'device', now + 900_000, 'https://example.test/reload', 'RELOAD-CODE')
  const claim = db.claimOAuthSession({
    state: 'reload-claimed',
    provider: 'grok',
    linuxdoId: 8,
    operationToken: 'reload-operation',
    now: now + 1,
    operationExpiresAt: now + 300_000,
  })
  assert.equal(claim.status, 'claimed')

  const recovered = collect.recoverOAuthSession(user(8), 'grok')
  assert.deepEqual(recovered, {
    provider: 'grok',
    state: 'reload-claimed',
    url: 'https://example.test/reload',
    flow: 'device',
    userCode: 'RELOAD-CODE',
    expiresAt: now + 900_000,
  })
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 9,
      leaseToken: 'reload-must-stay-fenced',
      now: now + 2,
      expiresAt: now + 60_000,
    }),
    false,
  )
  assert.equal(db.releaseOAuthOperation('reload-claimed', leaseToken, 'reload-operation'), true)
})

test('recovery remains actionable through its displayed deadline and the hard fence covers one full operation', () => {
  const now = 1_000
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  const leaseToken = seedSession(8, 'codex', 'hard-cap', [], now, expiresAt, hardExpiresAt)

  const claim = db.claimOAuthSession({
    state: 'hard-cap',
    provider: 'codex',
    linuxdoId: 8,
    operationToken: 'last-valid-operation',
    now: expiresAt - 1,
    operationExpiresAt: hardExpiresAt - 1,
  })
  assert.equal(claim.status, 'claimed')
  assert.equal(db.releaseOAuthOperation('hard-cap', leaseToken, 'last-valid-operation'), true)
  assert.equal(db.recoverOAuthSession(8, 'codex', expiresAt - 1)?.expiresAt, expiresAt)
  assert.equal(db.recoverOAuthSession(8, 'codex', expiresAt), null)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex',
      linuxdoId: 9,
      leaseToken: 'blocked-during-hard-fence',
      now: expiresAt,
      expiresAt: hardExpiresAt + 1,
    }),
    false,
  )
  db.cleanupOAuthSessions(hardExpiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex',
      linuxdoId: 9,
      leaseToken: 'after-hard-fence',
      now: hardExpiresAt + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    true,
  )
})

test('confirmed redirect cancellation is idempotent and fences a late save into the successor snapshot', async () => {
  const now = Date.now()
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(9, 'claude', 'cancel-redirect', [], now, expiresAt, hardExpiresAt)
  markModernSession('cancel-redirect', 'redirect', hardExpiresAt)
  let cancelCalls = 0
  let releaseCancel!: () => void
  const cancelBarrier = new Promise<void>((resolve) => {
    releaseCancel = resolve
  })
  cpa.cancelOAuth = async () => {
    cancelCalls++
    await cancelBarrier
    return { cancelled: true }
  }

  const pending = collect.cancelOAuth(user(9), 'claude', 'cancel-redirect')
  await waitUntil(() => cancelCalls === 1)
  assert.equal(collect.recoverOAuthSession(user(9), 'claude'), null)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 10,
      leaseToken: 'blocked-before-upstream-confirmation',
      now: now + 1,
      expiresAt: hardExpiresAt + 1,
    }),
    false,
  )
  releaseCancel()
  assert.deepEqual(await pending, { status: 'cancelled' })
  let finishCalls = 0
  cpa.finishOAuth = async () => {
    finishCalls++
    throw new Error('cancelled tombstone must stop before CPA')
  }
  const cancelledFinish = await collect.finishOAuth(
    user(9),
    'claude',
    'https://app.test/callback?state=cancel-redirect',
  )
  assert.equal(cancelledFinish.ok, false)
  if (!cancelledFinish.ok) assert.equal(cancelledFinish.code, 'OAUTH_CANCELLED')
  assert.equal(finishCalls, 0)
  assert.deepEqual(
    await collect.cancelOAuth(user(9), 'claude', 'cancel-redirect'),
    { status: 'cancelled' },
  )
  assert.equal(cancelCalls, 1)
  const raw = rawDb()
  const cancelled = raw.prepare(
    "SELECT status FROM oauth_snapshots WHERE state='cancel-redirect'",
  ).get() as { status: string }
  raw.close()
  assert.equal(cancelled.status, 'CANCEL_CONFIRMED')
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 10,
      leaseToken: 'blocked-after-confirmed-cancel',
      now: now + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    false,
  )

  cpa.listAuthFiles = async () => [
    {
      name: 'claude-old-late.json',
      accountId: 'old-late-account',
      email: '',
      plan: 'pro',
      disabled: false,
      provider: 'claude',
    },
  ]
  db.cleanupOAuthSessions(hardExpiresAt + 1)
  cpa.startOAuth = async () => ({
    state: 'successor-redirect',
    url: 'https://example.test/successor-redirect',
    flow: 'redirect',
  })
  const successor = await collect.startOAuth(user(10), 'claude')
  assert.equal(successor.state, 'successor-redirect')
  assert.deepEqual(db.getOAuthSnapshot('successor-redirect'), ['claude-old-late.json'])
})

test('device cancellation keeps a tombstone and provider fence through the conservative pollution window', async () => {
  const now = Date.now()
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(10, 'grok', 'cancel-device', [], now, expiresAt, hardExpiresAt)
  markModernSession('cancel-device', 'device', hardExpiresAt, 'https://example.test/device', 'DEVICE-CODE')
  cpa.cancelOAuth = async () => {
    throw new Error('legacy CPAMP has no cancel route')
  }

  assert.deepEqual(
    await collect.cancelOAuth(user(10), 'grok', 'cancel-device'),
    { status: 'cancelled' },
  )
  assert.equal(collect.recoverOAuthSession(user(10), 'grok'), null)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 11,
      leaseToken: 'must-remain-fenced',
      now: now + 1,
      expiresAt: now + 60_000,
    }),
    false,
  )

  db.cleanupOAuthSessions(hardExpiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 11,
      leaseToken: 'after-device-window',
      now: hardExpiresAt + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    true,
  )
})

test('cancelled:false is an unconfirmed no-op and keeps the provider fence until hard expiry', async () => {
  const now = Date.now()
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(109, 'claude', 'cancel-noop', [], now, expiresAt, hardExpiresAt)
  markModernSession('cancel-noop', 'redirect', hardExpiresAt)
  cpa.cancelOAuth = async () => ({ cancelled: false })

  assert.deepEqual(
    await collect.cancelOAuth(user(109), 'claude', 'cancel-noop'),
    { status: 'cancelled' },
  )
  assert.equal(collect.recoverOAuthSession(user(109), 'claude'), null)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 110,
      leaseToken: 'blocked-after-cancel-noop',
      now: now + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    false,
  )
  db.cleanupOAuthSessions(hardExpiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 110,
      leaseToken: 'after-cancel-noop-hard-expiry',
      now: hardExpiresAt + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    true,
  )
})

test('a late cancelled device auth file is fenced into the successor before-snapshot', async () => {
  const now = Date.now()
  const expiresAt = now + 1_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(110, 'grok', 'old-device', [], now, expiresAt, hardExpiresAt)
  markModernSession('old-device', 'device', hardExpiresAt, 'https://example.test/old-device', 'OLD-CODE')
  cpa.cancelOAuth = async () => {
    throw new Error('upstream cancellation unavailable')
  }
  await collect.cancelOAuth(user(110), 'grok', 'old-device')

  db.cleanupOAuthSessions(expiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 111,
      leaseToken: 'too-early-successor',
      now: expiresAt + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    false,
  )

  const files = [
    {
      name: 'xai-old-late.json',
      accountId: 'old-late-account',
      email: '',
      plan: 'super',
      disabled: false,
      provider: 'grok' as const,
    },
  ]
  cpa.listAuthFiles = async () => files
  db.cleanupOAuthSessions(hardExpiresAt + 1)
  cpa.startOAuth = async () => ({
    state: 'successor-device',
    url: 'https://example.test/successor-device',
    flow: 'device',
    userCode: 'NEW-CODE',
    expiresIn: 1800,
  })
  const successor = await collect.startOAuth(user(111), 'grok')
  assert.equal(successor.state, 'successor-device')
  assert.deepEqual(db.getOAuthSnapshot('successor-device'), ['xai-old-late.json'])

  let sawOldFileInBefore = false
  cpa.checkOAuth = async (_provider, _state, _known, before) => {
    sawOldFileInBefore = before.has('xai-old-late.json')
    return {
      status: 'ok',
      ingest: {
        accountId: 'successor-account',
        email: '',
        plan: 'super',
        authFileName: 'xai-successor.json',
        duplicate: false,
      },
    }
  }
  const completed = await collect.checkOAuth(user(111), 'grok', 'successor-device')
  assert.equal(sawOldFileInBefore, true)
  assert.equal(completed.done, true)
})

test('wrong owner/provider cancellation is generalized, never touches CPA, and cannot release the owner lease', async () => {
  const now = Date.now()
  seedSession(11, 'claude', 'owned-cancel', [], now, now + 900_000)
  markModernSession('owned-cancel', 'redirect', now + 900_000)
  let cpaCalls = 0
  cpa.startOAuth = async () => {
    cpaCalls++
    throw new Error('must not start')
  }
  cpa.finishOAuth = async () => {
    cpaCalls++
    throw new Error('must not finish')
  }
  cpa.checkOAuth = async () => {
    cpaCalls++
    throw new Error('must not check')
  }
  cpa.cancelOAuth = async () => {
    cpaCalls++
    throw new Error('must not cancel')
  }

  assert.deepEqual(
    await collect.cancelOAuth(user(99), 'claude', 'owned-cancel'),
    { status: 'invalid' },
  )
  assert.deepEqual(
    await collect.cancelOAuth(user(11), 'codex', 'owned-cancel'),
    { status: 'invalid' },
  )
  assert.equal(cpaCalls, 0)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 99,
      leaseToken: 'must-stay-owned',
      now: now + 1,
      expiresAt: now + 60_000,
    }),
    false,
  )
  assert.equal(collect.recoverOAuthSession(user(11), 'claude')?.state, 'owned-cancel')
})

test('cancellation during CPA await discards the late result before isolate or contribution writes', async () => {
  const now = Date.now()
  const hardExpiresAt = now + 900_000
  seedSession(12, 'claude', 'cancel-in-flight', [], now, hardExpiresAt, hardExpiresAt)
  markModernSession('cancel-in-flight', 'redirect', hardExpiresAt)
  let finishCalls = 0
  let isolateCalls = 0
  let releaseFinish!: () => void
  const barrier = new Promise<void>((resolve) => {
    releaseFinish = resolve
  })
  cpa.finishOAuth = async () => {
    finishCalls++
    await barrier
    return {
      accountId: 'late-account',
      email: '',
      plan: 'pro',
      authFileName: 'late-auth.json',
      duplicate: false,
    }
  }
  cpa.setDisabled = async () => {
    isolateCalls++
  }
  cpa.cancelOAuth = async () => ({ cancelled: true })

  const pending = collect.finishOAuth(
    user(12),
    'claude',
    'https://app.test/callback?state=cancel-in-flight',
  )
  await waitUntil(() => finishCalls === 1)
  const cancelled = await collect.cancelOAuth(user(12), 'claude', 'cancel-in-flight')
  const rawBeforeFinish = rawDb()
  const statusBeforeFinish = rawBeforeFinish.prepare(
    "SELECT status FROM oauth_snapshots WHERE state='cancel-in-flight'",
  ).get() as { status: string }
  rawBeforeFinish.close()
  const successorEnteredEarly = db.acquireOAuthProviderLease({
    provider: 'claude',
    linuxdoId: 13,
    leaseToken: 'must-wait-for-old-finalizer',
    now: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  releaseFinish()
  const result = await pending

  assert.deepEqual(cancelled, { status: 'cancelled' })
  assert.equal(statusBeforeFinish.status, 'CANCEL_CONFIRMED')
  assert.equal(successorEnteredEarly, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'OAUTH_CANCELLED')
  assert.equal(isolateCalls, 0)
  const raw = rawDb()
  const count = raw.prepare("SELECT COUNT(*) AS n FROM contributions WHERE account_id='late-account'").get() as { n: number }
  raw.close()
  assert.equal(count.n, 0)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 13,
      leaseToken: 'blocked-after-settled-cancel',
      now: Date.now(),
      expiresAt: hardExpiresAt + 60_000,
    }),
    false,
  )
  db.cleanupOAuthSessions(hardExpiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 13,
      leaseToken: 'after-in-flight-hard-expiry',
      now: hardExpiresAt + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    true,
  )
})

test('device cancellation racing a completed poll returns OAUTH_CANCELLED without isolate or contribution writes', async () => {
  const now = Date.now()
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(120, 'grok', 'cancel-device-in-flight', [], now, expiresAt, hardExpiresAt)
  markModernSession(
    'cancel-device-in-flight',
    'device',
    hardExpiresAt,
    'https://example.test/device-race',
    'RACE-CODE',
  )
  let checkCalls = 0
  let isolateCalls = 0
  let releaseCheck!: () => void
  const barrier = new Promise<void>((resolve) => {
    releaseCheck = resolve
  })
  cpa.checkOAuth = async () => {
    checkCalls++
    await barrier
    return {
      status: 'ok',
      ingest: {
        accountId: 'cancelled-device-account',
        email: '',
        plan: 'super',
        authFileName: 'xai-cancelled-device.json',
        duplicate: false,
      },
    }
  }
  cpa.setDisabled = async () => {
    isolateCalls++
  }
  cpa.cancelOAuth = async () => ({ cancelled: true })

  const pending = collect.checkOAuth(user(120), 'grok', 'cancel-device-in-flight')
  await waitUntil(() => checkCalls === 1)
  assert.deepEqual(
    await collect.cancelOAuth(user(120), 'grok', 'cancel-device-in-flight'),
    { status: 'cancelled' },
  )
  const rawBeforeCheck = rawDb()
  const statusBeforeCheck = rawBeforeCheck.prepare(
    "SELECT status FROM oauth_snapshots WHERE state='cancel-device-in-flight'",
  ).get() as { status: string }
  rawBeforeCheck.close()
  const successorEnteredEarly = db.acquireOAuthProviderLease({
    provider: 'grok',
    linuxdoId: 121,
    leaseToken: 'must-wait-for-old-check',
    now: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  releaseCheck()
  const result = await pending

  assert.equal(statusBeforeCheck.status, 'CANCEL_CONFIRMED')
  assert.equal(successorEnteredEarly, false)
  assert.equal(result.done, false)
  if (!result.done) assert.equal(result.code, 'OAUTH_CANCELLED')
  assert.equal(isolateCalls, 0)
  const raw = rawDb()
  const count = raw.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE account_id='cancelled-device-account'",
  ).get() as { n: number }
  raw.close()
  assert.equal(count.n, 0)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 121,
      leaseToken: 'blocked-after-device-settled-cancel',
      now: Date.now(),
      expiresAt: hardExpiresAt + 60_000,
    }),
    false,
  )
  db.cleanupOAuthSessions(hardExpiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'grok',
      linuxdoId: 121,
      leaseToken: 'after-device-in-flight-hard-expiry',
      now: hardExpiresAt + 1,
      expiresAt: hardExpiresAt + 60_000,
    }),
    true,
  )
})

test('redirect cleanup during isolate cannot commit a contribution or report success', async () => {
  const now = Date.now()
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(122, 'claude', 'cleanup-during-redirect-isolate', [], now, expiresAt, hardExpiresAt)
  markModernSession('cleanup-during-redirect-isolate', 'redirect', hardExpiresAt)

  let isolateCalls = 0
  let releaseIsolate!: () => void
  const isolateBarrier = new Promise<void>((resolve) => {
    releaseIsolate = resolve
  })
  cpa.finishOAuth = async () => ({
    accountId: 'expired-redirect-account',
    email: '',
    plan: 'pro',
    authFileName: 'anthropic-expired-redirect.json',
    duplicate: false,
  })
  cpa.setDisabled = async () => {
    isolateCalls++
    await isolateBarrier
  }

  const pending = collect.finishOAuth(
    user(122),
    'claude',
    'https://app.test/callback?state=cleanup-during-redirect-isolate',
  )
  await waitUntil(() => isolateCalls === 1)

  const beforeCleanup = rawDb()
  const operation = beforeCleanup.prepare(
    `SELECT status, operation_expires_at AS operationExpiresAt
     FROM oauth_snapshots WHERE state='cleanup-during-redirect-isolate'`,
  ).get() as { status: string; operationExpiresAt: number }
  beforeCleanup.close()
  assert.equal(operation.status, 'FINALIZING')

  db.cleanupOAuthSessions(operation.operationExpiresAt + 1)
  releaseIsolate()
  const result = await pending

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'OAUTH_CANCELLED')
  const raw = rawDb()
  const session = raw.prepare(
    `SELECT status, operation_token AS operationToken
     FROM oauth_snapshots WHERE state='cleanup-during-redirect-isolate'`,
  ).get() as { status: string; operationToken: string | null }
  const contribution = raw.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE account_id='expired-redirect-account'",
  ).get() as { n: number }
  raw.close()
  assert.equal(session.status, 'CANCELLED')
  assert.equal(session.operationToken, null)
  assert.equal(contribution.n, 0)
})

test('device cleanup during isolate cannot commit a contribution or report success', async () => {
  const now = Date.now()
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(123, 'grok', 'cleanup-during-device-isolate', [], now, expiresAt, hardExpiresAt)
  markModernSession(
    'cleanup-during-device-isolate',
    'device',
    hardExpiresAt,
    'https://example.test/device-cleanup',
    'CLEANUP-CODE',
  )

  let isolateCalls = 0
  let releaseIsolate!: () => void
  const isolateBarrier = new Promise<void>((resolve) => {
    releaseIsolate = resolve
  })
  cpa.checkOAuth = async () => ({
    status: 'ok',
    ingest: {
      accountId: 'expired-device-account',
      email: '',
      plan: 'super',
      authFileName: 'xai-expired-device.json',
      duplicate: false,
    },
  })
  cpa.setDisabled = async () => {
    isolateCalls++
    await isolateBarrier
  }

  const pending = collect.checkOAuth(user(123), 'grok', 'cleanup-during-device-isolate')
  await waitUntil(() => isolateCalls === 1)

  const beforeCleanup = rawDb()
  const operation = beforeCleanup.prepare(
    `SELECT status, operation_expires_at AS operationExpiresAt
     FROM oauth_snapshots WHERE state='cleanup-during-device-isolate'`,
  ).get() as { status: string; operationExpiresAt: number }
  beforeCleanup.close()
  assert.equal(operation.status, 'FINALIZING')

  db.cleanupOAuthSessions(operation.operationExpiresAt + 1)
  releaseIsolate()
  const result = await pending

  assert.equal(result.done, false)
  if (!result.done) assert.equal(result.code, 'OAUTH_CANCELLED')
  const raw = rawDb()
  const session = raw.prepare(
    `SELECT status, operation_token AS operationToken
     FROM oauth_snapshots WHERE state='cleanup-during-device-isolate'`,
  ).get() as { status: string; operationToken: string | null }
  const contribution = raw.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE account_id='expired-device-account'",
  ).get() as { n: number }
  raw.close()
  assert.equal(session.status, 'CANCELLED')
  assert.equal(session.operationToken, null)
  assert.equal(contribution.n, 0)
})

test('single-writer contract blocks RT upload while a codex OAuth lease owns the provider', async () => {
  const now = Date.now()
  const expiresAt = now + 900_000
  const hardExpiresAt = expiresAt + collect.OAUTH_OPERATION_TTL_MS
  seedSession(124, 'codex', 'oauth-blocks-rt-writer', ['codex-old.json'], now, expiresAt, hardExpiresAt)
  markModernSession('oauth-blocks-rt-writer', 'redirect', hardExpiresAt)

  let rtUploads = 0
  let isolateCalls = 0
  cpa.ingestRefreshToken = async () => {
    rtUploads++
    return {
      accountId: 'rt-race-account',
      email: '',
      plan: 'plus',
      authFileName: 'codex-rt-race.json',
      duplicate: false,
    }
  }
  cpa.setDisabled = async () => {
    isolateCalls++
  }

  const result = await collect.ingestRT(user(125), 'refresh-token-race')

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'PROVIDER_BUSY')
  assert.equal(rtUploads, 0, 'RT must stop before token exchange or auth-file upload')
  assert.equal(isolateCalls, 0, 'a blocked RT must not isolate any auth file')
  const raw = rawDb()
  const contribution = raw.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE account_id='rt-race-account'",
  ).get() as { n: number }
  raw.close()
  assert.equal(contribution.n, 0)
  assert.deepEqual(db.getOAuthSnapshot('oauth-blocks-rt-writer'), ['codex-old.json'])
})

test('single-writer contract holds the RT lease through upload and blocks OAuth start', async () => {
  let rtUploads = 0
  let oauthStarts = 0
  let releaseUpload!: () => void
  const uploadBarrier = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  cpa.ingestRefreshToken = async () => {
    rtUploads++
    await uploadBarrier
    return {
      accountId: 'rt-owned-account',
      email: '',
      plan: 'plus',
      authFileName: 'codex-rt-owned.json',
      duplicate: false,
    }
  }
  cpa.listAuthFiles = async () => []
  cpa.startOAuth = async () => {
    oauthStarts++
    return { state: 'after-rt-state', url: 'https://example.test/after-rt', flow: 'redirect' }
  }
  cpa.setDisabled = async () => {}

  const pendingRt = collect.ingestRT(user(126), 'refresh-token-owned')
  await waitUntil(() => rtUploads === 1)
  await assert.rejects(
    () => collect.startOAuth(user(127), 'codex'),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'PROVIDER_BUSY',
  )
  assert.equal(oauthStarts, 0, 'OAuth must stop before CPA while RT owns the provider lease')

  releaseUpload()
  const rtResult = await pendingRt
  assert.equal(rtResult.ok, true)

  const oauth = await collect.startOAuth(user(127), 'codex')
  assert.equal(oauth.state, 'after-rt-state')
  assert.equal(oauthStarts, 1)
})

test('ambiguous RT auth-file upload retains a bounded provider fence with zero isolation or writes', async () => {
  let rtUploads = 0
  let oauthStarts = 0
  let isolateCalls = 0
  cpa.ingestRefreshToken = async () => {
    rtUploads++
    throw new AuthFileUploadOutcomeUnknownError()
  }
  cpa.listAuthFiles = async () => []
  cpa.startOAuth = async () => {
    oauthStarts++
    return { state: 'must-not-start-after-ambiguous-rt', url: 'https://example.test/oauth', flow: 'redirect' }
  }
  cpa.setDisabled = async () => {
    isolateCalls++
  }

  const error = await collect.ingestRT(user(128), 'refresh-token-ambiguous').then(
    () => null,
    (caught) => caught as Error,
  )

  assert.equal(error?.message, cpaUnavailable)
  assert.equal(rtUploads, 1)
  assert.equal(isolateCalls, 0)
  assert.equal(db.balance(128), 0)
  const raw = rawDb()
  const lease = raw.prepare(
    `SELECT lease_token AS leaseToken, linuxdo_id AS linuxdoId,
            created_at AS createdAt, expires_at AS expiresAt
     FROM oauth_provider_leases WHERE provider='codex'`,
  ).get() as { leaseToken: string; linuxdoId: number; createdAt: number; expiresAt: number }
  const contribution = raw.prepare('SELECT COUNT(*) AS n FROM contributions').get() as { n: number }
  raw.close()
  assert.equal(lease.linuxdoId, 128)
  assert.ok(lease.expiresAt > Date.now(), 'ambiguous upload fence must remain active but bounded')
  assert.equal(contribution.n, 0)

  await assert.rejects(
    () => collect.startOAuth(user(129), 'codex'),
    (caught: unknown) =>
      typeof caught === 'object' &&
      caught !== null &&
      'code' in caught &&
      (caught as { code?: unknown }).code === 'PROVIDER_BUSY',
  )
  assert.equal(oauthStarts, 0, 'a successor OAuth must stop before CPA while the ambiguous RT fence is active')
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex',
      linuxdoId: 130,
      leaseToken: 'before-ambiguous-expiry',
      now: lease.expiresAt - 1,
      expiresAt: lease.expiresAt + 60_000,
    }),
    false,
  )
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex',
      linuxdoId: 130,
      leaseToken: 'at-ambiguous-expiry',
      now: lease.expiresAt,
      expiresAt: lease.expiresAt + 60_000,
    }),
    true,
  )
})

test('late RT upload results revalidate the exact provider lease generation before isolation', async () => {
  const mutations = ['token', 'owner', 'created-at', 'expiry'] as const

  for (const [index, mutation] of mutations.entries()) {
    clearOAuthState()
    let rtUploads = 0
    let isolateCalls = 0
    let releaseUpload!: () => void
    const uploadBarrier = new Promise<void>((resolve) => {
      releaseUpload = resolve
    })
    const accountId = `late-rt-${mutation}`
    cpa.ingestRefreshToken = async () => {
      rtUploads++
      await uploadBarrier
      return {
        accountId,
        email: '',
        plan: 'plus',
        authFileName: `codex-${accountId}.json`,
        duplicate: false,
      }
    }
    cpa.setDisabled = async () => {
      isolateCalls++
    }

    const linuxdoId = 140 + index
    const pending = collect.ingestRT(user(linuxdoId), `refresh-token-${mutation}`)
    await waitUntil(() => rtUploads === 1)

    const raw = rawDb()
    const lease = raw.prepare(
      `SELECT lease_token AS leaseToken, linuxdo_id AS linuxdoId,
              created_at AS createdAt, expires_at AS expiresAt
       FROM oauth_provider_leases WHERE provider='codex'`,
    ).get() as { leaseToken: string; linuxdoId: number; createdAt: number; expiresAt: number }
    if (mutation === 'token') {
      raw.prepare("UPDATE oauth_provider_leases SET lease_token='replacement-token' WHERE provider='codex'").run()
    } else if (mutation === 'owner') {
      raw.prepare('UPDATE oauth_provider_leases SET linuxdo_id=? WHERE provider=?').run(999, 'codex')
    } else if (mutation === 'created-at') {
      raw.prepare('UPDATE oauth_provider_leases SET created_at=? WHERE provider=?').run(lease.createdAt + 1, 'codex')
    } else {
      raw.prepare('UPDATE oauth_provider_leases SET expires_at=? WHERE provider=?').run(lease.expiresAt + 1, 'codex')
    }
    raw.close()

    releaseUpload()
    const error = await pending.then(() => null, (caught) => caught as Error)
    assert.equal(error?.message, cpaUnavailable, mutation)
    assert.equal(isolateCalls, 0, `${mutation}: stale RT must stop before isolation`)
    assert.equal(db.balance(linuxdoId), 0, mutation)
    const verify = rawDb()
    const contribution = verify.prepare(
      'SELECT COUNT(*) AS n FROM contributions WHERE account_id=?',
    ).get(accountId) as { n: number }
    const retained = verify.prepare(
      `SELECT lease_token AS leaseToken, linuxdo_id AS linuxdoId,
              created_at AS createdAt, expires_at AS expiresAt
       FROM oauth_provider_leases WHERE provider='codex'`,
    ).get() as { leaseToken: string; linuxdoId: number; createdAt: number; expiresAt: number }
    verify.close()
    assert.equal(contribution.n, 0, mutation)
    if (mutation === 'token') assert.equal(retained.leaseToken, 'replacement-token')
    if (mutation === 'owner') assert.equal(retained.linuxdoId, 999)
    if (mutation === 'created-at') assert.equal(retained.createdAt, lease.createdAt + 1)
    if (mutation === 'expiry') assert.equal(retained.expiresAt, lease.expiresAt + 1)
  }
})

test('RT finalization rechecks the exact lease after isolation and rolls back contribution writes', async () => {
  let isolateCalls = 0
  let releaseIsolate!: () => void
  const isolateBarrier = new Promise<void>((resolve) => {
    releaseIsolate = resolve
  })
  cpa.ingestRefreshToken = async () => ({
    accountId: 'rt-stale-during-isolate',
    email: '',
    plan: 'plus',
    authFileName: 'codex-rt-stale-during-isolate.json',
    duplicate: false,
  })
  cpa.setDisabled = async () => {
    isolateCalls++
    await isolateBarrier
  }

  const pending = collect.ingestRT(user(150), 'refresh-token-stale-during-isolate')
  await waitUntil(() => isolateCalls === 1)
  const raw = rawDb()
  const active = raw.prepare(
    `SELECT expires_at AS expiresAt FROM oauth_provider_leases WHERE provider='codex'`,
  ).get() as { expiresAt: number }
  raw.prepare(
    `UPDATE oauth_provider_leases
     SET lease_token='replacement-after-isolate', linuxdo_id=999, created_at=created_at+1, expires_at=?
     WHERE provider='codex'`,
  ).run(active.expiresAt + 60_000)
  raw.close()

  releaseIsolate()
  const error = await pending.then(() => null, (caught) => caught as Error)
  assert.equal(error?.message, cpaUnavailable)
  assert.equal(db.balance(150), 0)
  const verify = rawDb()
  const contribution = verify.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE account_id='rt-stale-during-isolate'",
  ).get() as { n: number }
  const replacement = verify.prepare(
    `SELECT lease_token AS leaseToken, linuxdo_id AS linuxdoId
     FROM oauth_provider_leases WHERE provider='codex'`,
  ).get() as { leaseToken: string; linuxdoId: number }
  verify.close()
  assert.equal(contribution.n, 0)
  assert.deepEqual({ ...replacement }, { leaseToken: 'replacement-after-isolate', linuxdoId: 999 })
})

test('atomic RT finalizer rejects an expired exact generation with zero contribution writes', () => {
  const leaseToken = 'rt-expired-finalizer-token'
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex',
      linuxdoId: 151,
      leaseToken,
      now: 100,
      expiresAt: 200,
    }),
    true,
  )
  assert.equal(
    db.beginRTFinalization({
      provider: 'codex',
      linuxdoId: 151,
      leaseToken,
      leaseCreatedAt: 100,
      expectedExpiresAt: 200,
      now: 110,
      finalizationExpiresAt: 300,
    }),
    true,
  )

  assert.deepEqual(
    db.finalizeRTIngest({
      provider: 'codex',
      linuxdoId: 151,
      leaseToken,
      leaseCreatedAt: 100,
      expectedExpiresAt: 300,
      now: 300,
      contribution: rtContribution(151, 'rt-expired-finalizer-account'),
    }),
    { status: 'stale' },
  )
  const raw = rawDb()
  const contribution = raw.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE account_id='rt-expired-finalizer-account'",
  ).get() as { n: number }
  raw.close()
  assert.equal(contribution.n, 0)
  assert.equal(db.balance(151), 0)
})

test('atomic OAuth ingest revalidates operation token, provider lease, and hard expiry with zero writes', () => {
  const cases = [
    { state: 'atomic-wrong-operation', accountId: 'atomic-wrong-operation-account', mutation: 'operation' },
    { state: 'atomic-missing-lease', accountId: 'atomic-missing-lease-account', mutation: 'lease' },
    { state: 'atomic-hard-expired', accountId: 'atomic-hard-expired-account', mutation: 'hard-expiry' },
  ] as const
  const providers: ProviderId[] = ['codex', 'claude', 'grok']

  for (const [index, item] of cases.entries()) {
    const linuxdoId = 130 + index
    const provider = providers[index]
    const now = 100
    const hardExpiresAt = 1_000
    const leaseToken = seedSession(linuxdoId, provider, item.state, [], now, 900, hardExpiresAt)
    const operationToken = `operation-${item.state}`
    assert.equal(
      db.claimOAuthSession({
        state: item.state,
        provider,
        linuxdoId,
        operationToken,
        now: 110,
        operationExpiresAt: 500,
      }).status,
      'claimed',
    )
    assert.deepEqual(
      db.beginOAuthFinalization({ state: item.state, leaseToken, operationToken, now: 120 }),
      { status: 'finalizing' },
    )

    let commitNow = 130
    let commitOperation = operationToken
    const raw = rawDb()
    if (item.mutation === 'operation') commitOperation = 'wrong-operation-token'
    if (item.mutation === 'lease') {
      raw.prepare('DELETE FROM oauth_provider_leases WHERE provider=?').run(provider)
    }
    if (item.mutation === 'hard-expiry') {
      raw.prepare('UPDATE oauth_provider_leases SET expires_at=2000 WHERE provider=?').run(provider)
      raw.prepare('UPDATE oauth_snapshots SET operation_expires_at=2000 WHERE state=?').run(item.state)
      commitNow = hardExpiresAt + 1
    }
    raw.close()

    assert.notEqual(
      db.finalizeOAuthIngest({
        state: item.state,
        provider,
        linuxdoId,
        leaseToken,
        operationToken: commitOperation,
        now: commitNow,
        contribution: oauthContribution(linuxdoId, provider, item.accountId),
      }).status,
      'committed',
      item.mutation,
    )

    const verify = rawDb()
    const contribution = verify.prepare(
      'SELECT COUNT(*) AS n FROM contributions WHERE account_id=?',
    ).get(item.accountId) as { n: number }
    verify.close()
    assert.equal(contribution.n, 0, item.mutation)
  }
})

test('cancel plus transient redirect failure keeps the provider fence until hard expiry', async () => {
  const now = Date.now()
  seedSession(13, 'claude', 'cancel-transient', [], now, now + 900_000)
  markModernSession('cancel-transient', 'redirect', now + 900_000)
  let finishCalls = 0
  let releaseFinish!: () => void
  const barrier = new Promise<void>((resolve) => {
    releaseFinish = resolve
  })
  cpa.finishOAuth = async () => {
    finishCalls++
    await barrier
    throw new Error('temporary callback timeout')
  }
  cpa.cancelOAuth = async () => {
    throw new Error('upstream cancellation unavailable')
  }

  const pending = collect.finishOAuth(
    user(13),
    'claude',
    'https://app.test/callback?state=cancel-transient',
  )
  await waitUntil(() => finishCalls === 1)
  assert.deepEqual(
    await collect.cancelOAuth(user(13), 'claude', 'cancel-transient'),
    { status: 'cancelled' },
  )
  releaseFinish()
  await assert.rejects(
    pending,
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'OAUTH_CANCELLED',
  )

  const raw = rawDb()
  const row = raw.prepare(
    `SELECT status,
            operation_expires_at AS operationExpiresAt,
            hard_expires_at AS hardExpiresAt
     FROM oauth_snapshots WHERE state='cancel-transient'`,
  ).get() as { status: string; operationExpiresAt: number; hardExpiresAt: number }
  raw.close()
  assert.equal(row.status, 'CANCELLED')
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 14,
      leaseToken: 'before-transient-window',
      now: row.operationExpiresAt - 1,
      expiresAt: row.operationExpiresAt + 60_000,
    }),
    false,
  )

  db.cleanupOAuthSessions(row.operationExpiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 14,
      leaseToken: 'after-transient-window',
      now: row.operationExpiresAt + 1,
      expiresAt: row.operationExpiresAt + 60_000,
    }),
    false,
  )
  db.cleanupOAuthSessions(row.hardExpiresAt + 1)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 14,
      leaseToken: 'after-transient-hard-expiry',
      now: row.hardExpiresAt + 1,
      expiresAt: row.hardExpiresAt + 60_000,
    }),
    true,
  )
})

test('cancel-pending operations remain fenced until hard expiry; stale finalizers cannot touch successors', () => {
  const oldLease = seedSession(14, 'codex', 'old-cancelled', [], 100, 1_000)
  markModernSession('old-cancelled', 'redirect', 1_000)
  const oldClaim = db.claimOAuthSession({
    state: 'old-cancelled',
    provider: 'codex',
    linuxdoId: 14,
    operationToken: 'old-operation',
    now: 110,
    operationExpiresAt: 500,
  })
  assert.equal(oldClaim.status, 'claimed')
  const cancelled = db.cancelOAuthSession({
    state: 'old-cancelled',
    provider: 'codex',
    linuxdoId: 14,
    now: 120,
  })
  assert.equal(cancelled.status, 'cancelled')

  db.cleanupOAuthSessions(499)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex',
      linuxdoId: 15,
      leaseToken: 'too-early',
      now: 499,
      expiresAt: 700,
    }),
    false,
  )

  db.cleanupOAuthSessions(501)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'codex',
      linuxdoId: 15,
      leaseToken: 'hard-expiry-required',
      now: 501,
      expiresAt: 700,
    }),
    false,
  )
  db.cleanupOAuthSessions(1_001)
  const newLease = seedSession(15, 'codex', 'successor', ['new-before.json'], 1_001, 1_400)
  markModernSession('successor', 'redirect', 1_400)
  assert.deepEqual(
    db.beginOAuthFinalization({
      state: 'old-cancelled',
      leaseToken: oldLease,
      operationToken: 'old-operation',
      now: 1_002,
    }),
    { status: 'stale' },
  )
  assert.equal(db.releaseOAuthProviderLease('codex', oldLease), false)
  assert.deepEqual(db.getOAuthSnapshot('successor'), ['new-before.json'])
  assert.notEqual(oldLease, newLease)
})

test('FINALIZING crash fails closed and keeps the provider fence until hard expiry', () => {
  const oldLease = seedSession(16, 'claude', 'finalizing-crash', [], 100, 1_000)
  const claim = db.claimOAuthSession({
    state: 'finalizing-crash',
    provider: 'claude',
    linuxdoId: 16,
    operationToken: 'crashed-finalizer',
    now: 110,
    operationExpiresAt: 500,
  })
  assert.equal(claim.status, 'claimed')
  assert.deepEqual(
    db.beginOAuthFinalization({
      state: 'finalizing-crash',
      leaseToken: oldLease,
      operationToken: 'crashed-finalizer',
      now: 120,
    }),
    { status: 'finalizing' },
  )

  db.cleanupOAuthSessions(501)
  assert.equal(db.recoverOAuthSession(16, 'claude', 501), null)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 17,
      leaseToken: 'blocked-after-finalizer-crash',
      now: 501,
      expiresAt: 700,
    }),
    false,
  )
  assert.equal(db.completeOAuthSession('finalizing-crash', oldLease, 'crashed-finalizer'), false)
  assert.equal(db.releaseOAuthOperation('finalizing-crash', oldLease, 'crashed-finalizer'), false)

  db.cleanupOAuthSessions(1_001)
  assert.equal(
    db.acquireOAuthProviderLease({
      provider: 'claude',
      linuxdoId: 17,
      leaseToken: 'after-finalizer-hard-expiry',
      now: 1_001,
      expiresAt: 1_400,
    }),
    true,
  )
  assert.equal(db.releaseOAuthProviderLease('claude', oldLease), false)
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
  const leaseToken = seedSession(5, 'codex', 'extended-operation', [], 100, 600)
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
  assert.deepEqual(
    db.beginOAuthFinalization({
      state: 'extended-operation',
      leaseToken,
      operationToken: 'extended-operation-token',
      now: 120,
    }),
    { status: 'finalizing' },
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
  if (!wrongUser.ok) assert.equal(wrongUser.code, 'OAUTH_SESSION_INVALID')
  const wrongProvider = await collect.finishOAuth(user(31), 'codex', 'https://app.test/callback?state=owned-state')
  assert.equal(wrongProvider.ok, false)
  if (!wrongProvider.ok) assert.equal(wrongProvider.code, 'OAUTH_SESSION_INVALID')

  const oldNow = Date.now() - 2_000
  seedSession(31, 'grok', 'expired-state', [], oldNow, oldNow + 1_000)
  const expired = await collect.finishOAuth(user(31), 'grok', 'https://app.test/callback?state=expired-state')
  assert.equal(expired.ok, false)
  if (!expired.ok) assert.equal(expired.code, 'OAUTH_SESSION_INVALID')

  const raw = rawDb()
  raw.prepare('INSERT INTO oauth_snapshots (state, file_names, created_at) VALUES (?,?,?)').run(
    'legacy-state',
    '[]',
    Date.now(),
  )
  raw.close()
  const legacy = await collect.finishOAuth(user(31), 'claude', 'https://app.test/callback?state=legacy-state')
  assert.equal(legacy.ok, false)
  if (!legacy.ok) assert.equal(legacy.code, 'OAUTH_SESSION_INVALID')
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
  assert.deepEqual(terminal, {
    done: true,
    result: { ok: false, code: 'UPSTREAM_AUTH_REJECTED', error: '授权失败' },
  })
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
