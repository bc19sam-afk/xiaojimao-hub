import { before, test } from 'node:test'
import assert from 'node:assert/strict'

// P7-R1: exercise the real client with a local fetch stub. No real CPA, account, or credential is used.
let cpa: typeof import('../lib/cpa.ts').cpa
let CPA_UNAVAILABLE: string

type JsonObject = Record<string, unknown>

function detail(overrides: JsonObject = {}): JsonObject {
  return {
    account_snapshot: 'acct-fixture',
    auth_provider_snapshot: 'codex',
    timestamp: '2026-07-20T01:02:03.000Z',
    ...overrides,
  }
}

function payload(details: JsonObject[]): JsonObject {
  return {
    apis: {
      'POST /v1/responses': {
        models: {
          'gpt-fixture': { details },
        },
      },
    },
  }
}

async function read(body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
  return cpa.getDailyUsage()
}

async function expectUnavailable(body: unknown): Promise<void> {
  const error = await read(body).then(() => null, (reason) => reason as Error)
  assert.ok(error, 'malformed usage payload must be rejected')
  assert.equal(error.message, CPA_UNAVAILABLE)
}

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'fixture-management-key'
  const mod = await import('../lib/cpa.ts')
  cpa = mod.cpa
  CPA_UNAVAILABLE = mod.CPA_UNAVAILABLE
})

test('usage accepts required containers, valid empty collections, and unknown extensions', async () => {
  assert.deepEqual(await read({ apis: {}, future: { version: 2 } }), [])
  assert.deepEqual(await read({ apis: { empty: { models: {} } } }), [])
  assert.deepEqual(await read({ apis: { empty: { models: { none: { details: [] } } } } }), [])

  const body = payload([
    detail({ future_detail_field: { safe: true } }),
    detail({ future_detail_field: { safe: true } }),
  ])
  ;(body.apis as JsonObject).future_api = { models: {} }
  const got = await read(body)
  assert.deepEqual(got, [
    { accountId: 'acct-fixture', provider: 'codex', date: '2026-07-20', count: 2 },
  ])
})

test('usage fails closed when apis/models/details are missing, wrong, or mixed with an invalid detail', async () => {
  await expectUnavailable({})
  await expectUnavailable({ apis: [] })
  await expectUnavailable({ apis: { api: {} } })
  await expectUnavailable({ apis: { api: { models: [] } } })
  await expectUnavailable({ apis: { api: { models: { model: {} } } } })
  await expectUnavailable({ apis: { api: { models: { model: { details: {} } } } } })

  const invalid = detail()
  delete invalid.account_snapshot
  await expectUnavailable(payload([detail(), invalid]))
})

test('usage rejects invalid required detail fields but preserves numeric timestamp compatibility', async () => {
  for (const invalid of [
    detail({ account_snapshot: '' }),
    detail({ auth_provider_snapshot: 'unknown-provider' }),
    detail({ timestamp: 'not-a-date' }),
    detail({ timestamp: Number.NaN }),
  ]) {
    await expectUnavailable(payload([invalid]))
  }

  assert.deepEqual(await read(payload([detail({ timestamp: 1_753_000_000 })])), [
    { accountId: 'acct-fixture', provider: 'codex', date: '2025-07-20', count: 1 },
  ])
})

test('usage allows 49,999 rows and fails the whole payload closed at 50,000 rows', async () => {
  const repeated = detail()
  const below = await read(payload(Array(49_999).fill(repeated)))
  assert.equal(below[0]?.count, 49_999)
  await expectUnavailable(payload(Array(50_000).fill(repeated)))

  const truncatedHint = payload(Array(49_999).fill(repeated))
  truncatedHint.total_requests = 50_000
  await expectUnavailable(truncatedHint)
})

test('usage payload failures expose only CPA_UNAVAILABLE and never log raw payload data', async () => {
  const sentinel = 'secret-usage-payload-sentinel'
  const logs: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '))
  try {
    await expectUnavailable({ apis: [], private_extension: sentinel })
    assert.ok(!logs.join('\n').includes(sentinel))
  } finally {
    console.error = originalError
  }
})
