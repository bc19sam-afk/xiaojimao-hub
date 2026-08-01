import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionUser } from '../lib/session.ts'
import { migrate } from '../lib/migrate.ts'

let cpa: typeof import('../lib/cpa.ts').cpa
let CPA_UNAVAILABLE: string
let collect: typeof import('../lib/collect.ts')
let db: typeof import('../lib/db.ts').db
let tmpDir: string
let dbPath: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-identity-validation-'))
  dbPath = path.join(tmpDir, 'app.db')
  process.env.MOCK = 'false'
  process.env.WORKER_ENABLED = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'test-management-key'
  process.env.DB_PATH = dbPath

  const bootstrap = new DatabaseSync(dbPath)
  migrate(bootstrap)
  bootstrap.close()

  const cpaModule = await import('../lib/cpa.ts')
  cpa = cpaModule.cpa
  CPA_UNAVAILABLE = cpaModule.CPA_UNAVAILABLE
  collect = await import('../lib/collect.ts')
  ;({ db } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

function user(id: number): SessionUser {
  return { id, username: `identity-${id}`, trustLevel: 2 }
}

function tableCount(table: 'contributions' | 'oauth_snapshots' | 'oauth_provider_leases'): number {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return (raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  } finally {
    raw.close()
  }
}

function idToken(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('auth-file rows reject missing, mistyped, and mixed valid-invalid identities as one unavailable batch', async () => {
  const malformedPayloads: Array<[string, unknown]> = [
    [
      'missing canonical account',
      { files: [{ name: 'codex-missing.json', provider: 'codex', email: 'valid@example.com', disabled: true }] },
    ],
    [
      'numeric accountId',
      { files: [{ name: 'codex-number.json', provider: 'codex', account_id: 123, email: 'valid@example.com' }] },
    ],
    [
      'numeric email',
      { files: [{ name: 'codex-email.json', provider: 'codex', account_id: 'acct-email', email: 123 }] },
    ],
    [
      'padded canonical account',
      { files: [{ name: 'codex-padded-id.json', provider: 'codex', account_id: ' acct-padded ', email: 'valid@example.com' }] },
    ],
    [
      'padded email',
      { files: [{ name: 'codex-padded-email.json', provider: 'codex', account_id: 'acct-email', email: ' valid@example.com ' }] },
    ],
    [
      'padded auth-file name',
      { files: [{ name: ' codex-padded-name.json', provider: 'codex', account_id: 'acct-name', email: 'valid@example.com' }] },
    ],
    [
      'mixed valid-invalid rows',
      {
        files: [
          { name: 'codex-valid.json', provider: 'codex', account_id: 'acct-valid', email: 'valid@example.com' },
          { name: 'claude-invalid.json', provider: 'claude', account: 456, email: 'claude@example.com' },
        ],
      },
    ],
  ]

  for (const [label, payload] of malformedPayloads) {
    globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch
    const error = await cpa.listAuthFiles().then(() => null, (caught) => caught as Error)
    assert.equal(error?.message, CPA_UNAVAILABLE, label)
  }
})

test('mixed invalid auth-file snapshot stops before OAuth start and leaves no session, lease, or contribution', async () => {
  for (const [label, invalidRow] of [
    [
      'numeric identity',
      { name: 'codex-invalid.json', provider: 'codex', account_id: 789, email: 'invalid@example.com' },
    ],
    [
      'padded filename',
      { name: ' codex-padded.json', provider: 'codex', account_id: 'acct-padded', email: 'valid@example.com' },
    ],
  ] as const) {
    let oauthStartCalls = 0
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url)
      if (target.endsWith('/v0/management/auth-files')) {
        return jsonResponse({
          files: [
            { name: 'codex-valid.json', provider: 'codex', account_id: 'acct-valid', email: 'valid@example.com' },
            invalidRow,
          ],
        })
      }
      if (target.includes('/v0/management/codex-auth-url')) {
        oauthStartCalls++
        return jsonResponse({ state: 'must-not-exist', url: 'https://auth.example/authorize' })
      }
      throw new Error(`unexpected request: ${target}`)
    }) as typeof fetch

    const currentUser = user(label === 'numeric identity' ? 9201 : 9202)
    const error = await collect.startOAuth(currentUser, 'codex').then(() => null, (caught) => caught as Error)

    assert.equal(error?.message, CPA_UNAVAILABLE, label)
    assert.equal(oauthStartCalls, 0, `${label}: invalid snapshots must fail before upstream OAuth`)
    assert.equal(tableCount('oauth_snapshots'), 0, label)
    assert.equal(tableCount('oauth_provider_leases'), 0, label)
    assert.equal(tableCount('contributions'), 0, label)
    assert.equal(collect.recoverOAuthSession(currentUser, 'codex'), null, label)
  }
})

test('decoded ID-token claims fail closed before auth-file upload, isolation, or DB writes', async () => {
  const malformedClaims: Array<[string, unknown]> = [
    ['missing account identity', { email: 'valid@example.com' }],
    ['numeric account identity', { account_id: 123, email: 'valid@example.com' }],
    ['numeric email', { account_id: 'acct-email-number', email: 123 }],
    ['padded account identity', { account_id: ' acct-padded ', email: 'valid@example.com' }],
    ['padded email', { account_id: 'acct-padded-email', email: ' valid@example.com ' }],
    [
      'mixed valid nested identity and invalid fallback',
      {
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-nested-valid' },
        account_id: 456,
        email: 'valid@example.com',
      },
    ],
    [
      'mixed invalid preferred identity and valid fallback',
      { chatgpt_account_id: 789, account_id: 'acct-fallback-valid', email: 'valid@example.com' },
    ],
  ]

  for (const [label, claims] of malformedClaims) {
    let uploadCalls = 0
    let isolationCalls = 0
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (target.includes('auth.openai.com/oauth/token')) {
        return jsonResponse({ access_token: 'access', id_token: idToken(claims), refresh_token: 'refresh' })
      }
      if (target.endsWith('/v0/management/auth-files') && method === 'POST') {
        uploadCalls++
        return new Response('', { status: 200 })
      }
      if (target.endsWith('/v0/management/auth-files/status') && method === 'PATCH') {
        isolationCalls++
        return new Response('', { status: 200 })
      }
      throw new Error(`unexpected request: ${method} ${target}`)
    }) as typeof fetch

    const beforeContributions = tableCount('contributions')
    const error = await collect.ingestRT(user(9301), `refresh-${label}`).then(
      () => null,
      (caught) => caught as Error,
    )

    assert.equal(error?.message, CPA_UNAVAILABLE, label)
    assert.equal(uploadCalls, 0, `${label}: auth-file upload must not run`)
    assert.equal(isolationCalls, 0, `${label}: isolate must not run`)
    assert.equal(tableCount('contributions'), beforeContributions, `${label}: DB must not change`)
    assert.deepEqual(db.byUser(9301), [], `${label}: malformed identity must not be stringified into SQLite`)
  }
})
