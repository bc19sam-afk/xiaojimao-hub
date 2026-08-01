import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Contribution } from '../lib/db.ts'
import { migrate } from '../lib/migrate.ts'

let cpa: typeof import('../lib/cpa.ts').cpa
let CPA_UNAVAILABLE: string
let collect: typeof import('../lib/collect.ts')
let db: typeof import('../lib/db.ts').db
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-inspection-validation-'))
  process.env.MOCK = 'false'
  process.env.WORKER_ENABLED = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'test-management-key'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')

  const bootstrap = new DatabaseSync(process.env.DB_PATH)
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

function stubInspection(runBody: unknown, detailBody: unknown): { mutations: string[] } {
  const mutations: string[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (target.endsWith('/v0/management/codex-inspection/run')) return jsonResponse(runBody)
    if (target.includes('/v0/management/codex-inspection/runs/')) return jsonResponse(detailBody)
    if (
      target.includes('/v0/management/auth-files') &&
      (method === 'PATCH' || method === 'DELETE' || method === 'POST')
    ) {
      mutations.push(`${method} ${target}`)
      return new Response('', { status: 200 })
    }
    throw new Error(`unexpected request: ${method} ${target}`)
  }) as typeof fetch
  return { mutations }
}

function makeContribution(id: string, accountId: string): Contribution {
  const now = Date.now()
  return {
    id,
    linuxdoId: 9101,
    username: 'inspection-test',
    accountId,
    email: 'inspection@example.com',
    provider: 'codex',
    plan: 'plus',
    method: 'oauth',
    authFileName: `codex-${accountId}.json`,
    verifyStatus: 'submitted',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
  }
}

test('inspection envelope fails closed on non-canonical run id and missing/mistyped completed results', async () => {
  for (const [label, runBody, detailBody] of [
    [
      'run id string',
      { run: { id: '7' } },
      { run: { status: 'completed' }, results: [] },
    ],
    [
      'completed without results',
      { run: { id: 8 } },
      { run: { status: 'completed' } },
    ],
    [
      'completed results object',
      { run: { id: 9 } },
      { run: { status: 'completed' }, results: {} },
    ],
  ] as const) {
    stubInspection(runBody, detailBody)
    const error = await cpa.inspect().then(() => null, (caught) => caught as Error)
    assert.equal(error?.message, CPA_UNAVAILABLE, label)
  }
})

test('real cpa.inspect keeps legacy rows without provider while strictly validating provider when present', async () => {
  stubInspection(
    { run: { id: 10 } },
    {
      run: { status: 'completed' },
      results: [
        {
          accountId: 'legacy-no-provider',
          statusCode: 200,
          action: 'keep',
          planType: 'plus',
        },
      ],
    },
  )

  assert.deepEqual(await cpa.inspect(), [
    {
      accountId: 'legacy-no-provider',
      decision: 'ok',
      plan: 'plus',
      reason: '',
      provider: undefined,
    },
  ])

  for (const [label, provider] of [
    ['provider number', 123],
    ['provider padded', ' codex '],
    ['provider unknown', 'unknown'],
  ] as const) {
    stubInspection(
      { run: { id: 10 } },
      {
        run: { status: 'completed' },
        results: [{ accountId: 'strict-provider', provider, statusCode: 200, action: 'keep' }],
      },
    )
    const error = await cpa.inspect().then(() => null, (caught) => caught as Error)
    assert.equal(error?.message, CPA_UNAVAILABLE, label)
  }
})

test('inspection rejects every malformed result row instead of mapping it to healthy', async () => {
  const malformedRows: Array<[string, unknown]> = [
    [
      'statusCode string',
      { accountId: 'inspect-string-code', provider: 'codex', statusCode: '401', action: 'keep' },
    ],
    [
      'action number',
      { accountId: 'inspect-number-action', provider: 'codex', statusCode: 401, action: 123 },
    ],
    [
      'account number',
      { accountId: 123, provider: 'codex', statusCode: 200, action: 'keep' },
    ],
    [
      'padded canonical account',
      { accountId: ' inspect-padded ', provider: 'codex', statusCode: 200, action: 'keep' },
    ],
    [
      'unknown provider',
      { accountId: 'inspect-provider', provider: 'unknown', statusCode: 200, action: 'keep' },
    ],
    [
      'padded provider',
      { accountId: 'inspect-provider', provider: ' codex ', statusCode: 200, action: 'keep' },
    ],
    [
      'unknown action enum',
      { accountId: 'inspect-action', provider: 'codex', statusCode: 200, action: 'archive' },
    ],
  ]

  for (const [label, row] of malformedRows) {
    stubInspection(
      { run: { id: 11 } },
      { run: { status: 'completed' }, results: [row] },
    )
    const error = await cpa.inspect().then(() => null, (caught) => caught as Error)
    assert.equal(error?.message, CPA_UNAVAILABLE, label)
  }
})

test('one malformed inspection row invalidates the whole batch with zero CPA mutations and zero state migration', async () => {
  const validA = makeContribution('inspection-valid-a', 'inspection-valid-a')
  const validB = makeContribution('inspection-valid-b', 'inspection-valid-b')
  assert.equal(db.insertUnique(validA).duplicate, false)
  assert.equal(db.insertUnique(validB).duplicate, false)

  const observed = stubInspection(
    { run: { id: 12 } },
    {
      run: { status: 'completed' },
      results: [
        {
          accountId: validA.accountId,
          provider: 'codex',
          statusCode: 200,
          action: 'keep',
          planType: 'plus',
        },
        {
          accountId: validB.accountId,
          provider: 'codex',
          statusCode: null,
          action: 'enable',
          planType: 'plus',
        },
        {
          accountId: ' poisoned-row ',
          provider: 'codex',
          statusCode: 200,
          action: 'keep',
        },
      ],
    },
  )

  const result = await collect.processPending()

  assert.equal(result.inspectFailed, true)
  assert.equal(result.activated, 0)
  assert.equal(result.rejected, 0)
  assert.deepEqual(observed.mutations, [], 'invalid inspection batches must not enable, reprioritize, or delete files')
  assert.equal(db.byUser(validA.linuxdoId).find((row) => row.id === validA.id)?.verifyStatus, 'submitted')
  assert.equal(db.byUser(validB.linuxdoId).find((row) => row.id === validB.id)?.verifyStatus, 'submitted')
})
