import { before, test } from 'node:test'
import assert from 'node:assert/strict'

let cpa: typeof import('../lib/cpa.ts').cpa
let CPA_UNAVAILABLE: string

const LEAK_URL = 'https://secret.example/oauth?token=should-not-leak'
const LEAK_BODY = 'external token=response-secret /private/oauth/path'

async function capture<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error; logs: string }> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  try {
    return { value: await fn(), logs: lines.join('\n') }
  } catch (error) {
    return { error: error as Error, logs: lines.join('\n') }
  } finally {
    console.error = original
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'test-management-key'
  const mod = await import('../lib/cpa.ts')
  cpa = mod.cpa
  CPA_UNAVAILABLE = mod.CPA_UNAVAILABLE
})

test('CPA OAuth start accepts only valid redirect/device response contracts', async () => {
  const validCases = [
    {
      payload: { state: 'redirect-state', url: 'https://auth.example/authorize' },
      expected: {
        state: 'redirect-state',
        url: 'https://auth.example/authorize',
        flow: 'redirect',
        userCode: undefined,
      },
    },
    {
      payload: {
        state: 'device-state',
        url: 'https://auth.example/device',
        user_code: 'ABCD-EFGH',
        expires_in: 1200,
      },
      expected: {
        state: 'device-state',
        url: 'https://auth.example/device',
        flow: 'device',
        userCode: 'ABCD-EFGH',
        expiresIn: 1200,
      },
    },
    {
      payload: {
        state: 'explicit-device',
        url: 'http://device.example/activate',
        flow: 'device',
        user_code: 'CODE-1234',
        expires_in: 3600,
      },
      expected: {
        state: 'explicit-device',
        url: 'http://device.example/activate',
        flow: 'device',
        userCode: 'CODE-1234',
        expiresIn: 1800,
      },
    },
  ]

  for (const { payload, expected } of validCases) {
    globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch
    assert.deepEqual(await cpa.startOAuth('codex'), expected)
  }
})

test('CPA OAuth start rejects missing, mistyped, invalid-URL, and invalid flow/userCode shapes without leaks', async () => {
  const malformed: unknown[] = [
    null,
    {},
    { state: 'state-only' },
    { state: '', url: 'https://auth.example/authorize' },
    { state: 123, url: 'https://auth.example/authorize' },
    { state: 's', url: null },
    { state: 's', url: 'not-a-url' },
    { state: 's', url: 'ftp://auth.example/authorize' },
    { state: 's', url: LEAK_URL, flow: 'unknown' },
    { state: 's', url: LEAK_URL, flow: 'redirect', user_code: 'unexpected' },
    { state: 's', url: LEAK_URL, flow: 'device' },
    { state: 's', url: LEAK_URL, user_code: 123 },
    { state: 's', url: LEAK_URL, user_code: 'CODE' },
    { state: 's', url: LEAK_URL, user_code: 'CODE', expires_in: 0 },
    { state: 's', url: LEAK_URL, user_code: 'CODE', expires_in: -1 },
    { state: 's', url: LEAK_URL, user_code: 'CODE', expires_in: 1.5 },
    { state: 's', url: LEAK_URL, user_code: 'CODE', expires_in: '1800' },
    { state: 's', url: LEAK_URL, flow: 'redirect', expires_in: 1800 },
  ]

  for (const payload of malformed) {
    globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch
    const result = await capture(() => cpa.startOAuth('codex'))
    assert.equal(result.error?.message, CPA_UNAVAILABLE, `payload must fail closed: ${JSON.stringify(payload)}`)
    assert.match(result.logs, /cpa\.oauth_start invalid_shape/)
    assert.equal(result.logs.includes(LEAK_URL), false)
    assert.equal(result.logs.includes(LEAK_BODY), false)
    assert.equal(result.logs.includes('test-management-key'), false)
  }
})

test('CPA OAuth cancellation validates the exact management response contract', async () => {
  const observed: Array<{ url: string; method?: string }> = []
  for (const cancelled of [true, false]) {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      observed.push({ url: String(url), method: init?.method })
      return jsonResponse({ status: 'ok', cancelled })
    }) as typeof fetch
    assert.deepEqual(await cpa.cancelOAuth('opaque state'), { cancelled })
  }

  assert.deepEqual(observed.map((request) => request.method), ['DELETE', 'DELETE'])
  assert.ok(observed.every((request) => request.url.endsWith('/v0/management/oauth-session?state=opaque%20state')))

  for (const payload of [
    null,
    {},
    { status: 'ok' },
    { status: 'error', cancelled: false },
    { status: 'ok', cancelled: 'true' },
  ]) {
    globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch
    const result = await capture(() => cpa.cancelOAuth('secret-state'))
    assert.equal(result.error?.message, CPA_UNAVAILABLE, `payload must fail closed: ${JSON.stringify(payload)}`)
    assert.match(result.logs, /cpa\.oauth_cancel invalid_shape/)
    assert.equal(result.logs.includes('secret-state'), false)
    assert.equal(result.logs.includes('test-management-key'), false)
  }
})

test('CPA OAuth cancellation treats a missing upstream route as unconfirmed', async () => {
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch
  const result = await capture(() => cpa.cancelOAuth('legacy-state'))
  assert.equal(result.error?.message, CPA_UNAVAILABLE)
  assert.match(result.logs, /cpa\.management_delete http status=404/)
  assert.equal(result.logs.includes('legacy-state'), false)
})

test('CPA OAuth status accepts only wait/ok/error and validates known field types', async () => {
  globalThis.fetch = (async (url: unknown) => {
    const value = String(url)
    if (value.includes('/get-auth-status')) return jsonResponse({ status: 'wait' })
    throw new Error('unexpected request')
  }) as typeof fetch
  assert.deepEqual(await cpa.checkOAuth('grok', 'wait-state', [], new Set()), { status: 'wait' })

  globalThis.fetch = (async (url: unknown) => {
    const value = String(url)
    if (value.includes('/get-auth-status')) return jsonResponse({ status: 'error', error: 'external detail' })
    throw new Error('unexpected request')
  }) as typeof fetch
  assert.deepEqual(await cpa.checkOAuth('grok', 'error-state', [], new Set()), {
    status: 'error',
    error: '授权失败',
  })

  globalThis.fetch = (async (url: unknown) => {
    const value = String(url)
    if (value.includes('/get-auth-status')) return jsonResponse({ status: 'ok' })
    if (value.endsWith('/v0/management/auth-files')) return jsonResponse({ files: [] })
    throw new Error('unexpected request')
  }) as typeof fetch
  const ok = await cpa.checkOAuth('grok', 'ok-state', [], new Set())
  assert.equal(ok.status, 'ok')
})

test('CPA OAuth status rejects empty, mistyped, and unknown responses without body/URL/token leakage', async () => {
  const malformed: unknown[] = [
    null,
    {},
    { status: '' },
    { status: 1 },
    { status: 'pending' },
    { status: 'unknown', error: LEAK_BODY },
    { status: 'error', error: 123 },
    { status: 'wait', error: 123 },
  ]

  for (const payload of malformed) {
    globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch
    const result = await capture(() => cpa.checkOAuth('grok', 'secret-state', [], new Set()))
    assert.equal(result.error?.message, CPA_UNAVAILABLE, `payload must fail closed: ${JSON.stringify(payload)}`)
    assert.match(result.logs, /cpa\.oauth_status invalid_shape/)
    assert.equal(result.logs.includes(LEAK_BODY), false)
    assert.equal(result.logs.includes(LEAK_URL), false)
    assert.equal(result.logs.includes('secret-state'), false)
    assert.equal(result.logs.includes('test-management-key'), false)
  }
})
