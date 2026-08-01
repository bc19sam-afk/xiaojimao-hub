import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const root = process.cwd()

function runIsolated(script: string, env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-test-module-mocks',
      '--import',
      './test/setup.mjs',
      '--input-type=module',
      '-e',
      script,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOCK: 'true',
        WORKER_ENABLED: 'false',
        SESSION_SECRET: 'x'.repeat(64),
        ...env,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout) as unknown
}

test('same-origin JSON mutation guard enforces fixed APP_BASE_URL exactly', () => {
  const result = runIsolated(
    String.raw`
      const { isSameOriginJsonMutation } = await import('./lib/request.ts')
      const request = (headers = {}) => new Request('http://internal:3000/api/collect/oauth/start', {
        method: 'POST',
        headers,
      })
      const json = { 'content-type': 'application/json' }
      const allowedOrigin = 'https://hub.example.test:8443'

      console.log(JSON.stringify({
        sameOrigin: isSameOriginJsonMutation(request({ ...json, origin: allowedOrigin })),
        jsonCharset: isSameOriginJsonMutation(request({
          origin: allowedOrigin,
          'content-type': 'application/json; charset=utf-8',
        })),
        caseInsensitiveMediaType: isSameOriginJsonMutation(request({
          origin: allowedOrigin,
          'content-type': 'Application/JSON; Charset=UTF-8',
        })),
        missingOrigin: isSameOriginJsonMutation(request(json)),
        nullOrigin: isSameOriginJsonMutation(request({ ...json, origin: 'null' })),
        malformedOrigin: isSameOriginJsonMutation(request({ ...json, origin: '://bad' })),
        siblingOrigin: isSameOriginJsonMutation(request({ ...json, origin: 'https://evil.example.test:8443' })),
        wrongScheme: isSameOriginJsonMutation(request({ ...json, origin: 'http://hub.example.test:8443' })),
        wrongPort: isSameOriginJsonMutation(request({ ...json, origin: 'https://hub.example.test:9443' })),
        originWithPath: isSameOriginJsonMutation(request({ ...json, origin: allowedOrigin + '/path' })),
        textPlain: isSameOriginJsonMutation(request({ origin: allowedOrigin, 'content-type': 'text/plain' })),
        missingContentType: isSameOriginJsonMutation(request({ origin: allowedOrigin })),
        spoofedForwardedIgnored: isSameOriginJsonMutation(request({
          ...json,
          origin: allowedOrigin,
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'evil.example.test',
        })),
      }))
    `,
    {
      APP_BASE_URL: 'https://hub.example.test:8443/app/',
      TRUST_FORWARDED_HEADERS: 'false',
    },
  )

  assert.deepEqual(result, {
    sameOrigin: true,
    jsonCharset: true,
    caseInsensitiveMediaType: true,
    missingOrigin: false,
    nullOrigin: false,
    malformedOrigin: false,
    siblingOrigin: false,
    wrongScheme: false,
    wrongPort: false,
    originWithPath: false,
    textPlain: false,
    missingContentType: false,
    spoofedForwardedIgnored: true,
  })
})

test('same-origin JSON mutation guard follows only the trusted proxy origin contract', () => {
  const result = runIsolated(
    String.raw`
      const { isSameOriginJsonMutation } = await import('./lib/request.ts')
      const request = (headers) => new Request('http://internal:3000/api/verify-now', {
        method: 'POST',
        headers,
      })
      const forwarded = {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'hub.example.test:9443',
      }

      console.log(JSON.stringify({
        trustedProxy: isSameOriginJsonMutation(request({
          ...forwarded,
          origin: 'https://hub.example.test:9443',
        })),
        siblingRejected: isSameOriginJsonMutation(request({
          ...forwarded,
          origin: 'https://evil.example.test:9443',
        })),
        wrongSchemeRejected: isSameOriginJsonMutation(request({
          ...forwarded,
          origin: 'http://hub.example.test:9443',
        })),
        wrongPortRejected: isSameOriginJsonMutation(request({
          ...forwarded,
          origin: 'https://hub.example.test:8443',
        })),
      }))
    `,
    {
      APP_BASE_URL: 'https://fixed.example.test',
      TRUST_FORWARDED_HEADERS: 'true',
    },
  )

  assert.deepEqual(result, {
    trustedProxy: true,
    siblingRejected: false,
    wrongSchemeRejected: false,
    wrongPortRejected: false,
  })
})

test('mutation routes reject sibling text/plain before auth and preserve OAuth body failures', () => {
  const result = runIsolated(
    String.raw`
      import { mock } from 'node:test'

      const calls = { userAuth: 0, adminAuth: 0, start: 0, check: 0, finish: 0, cancel: 0, verify: 0 }
      const resetCalls = () => { for (const key of Object.keys(calls)) calls[key] = 0 }

      mock.module(new URL('./lib/session.ts', import.meta.url), {
        exports: {
          getCurrentUser: async () => {
            calls.userAuth += 1
            return { id: 1, username: 'test', trustLevel: 4 }
          },
        },
      })
      mock.module(new URL('./lib/admin.ts', import.meta.url), {
        exports: {
          getAdminActor: async () => {
            calls.adminAuth += 1
            return { kind: 'linuxdo', linuxdoId: 1, username: 'test' }
          },
        },
      })
      mock.module(new URL('./lib/collect.ts', import.meta.url), {
        exports: {
          startOAuth: async () => {
            calls.start += 1
            return {
              provider: 'codex', state: 'state', url: 'https://example.test', flow: 'redirect', expiresAt: Date.now() + 60_000,
            }
          },
          checkOAuth: async () => { calls.check += 1; return { done: false } },
          finishOAuth: async () => { calls.finish += 1; return { ok: true } },
          cancelOAuth: async () => { calls.cancel += 1; return { status: 'cancelled' } },
          processPending: async () => { calls.verify += 1; return { activated: 1, rejected: 0 } },
        },
      })

      const { NextRequest } = await import('next/server')
      const routes = {
        start: await import('./app/api/collect/oauth/start/route.ts'),
        check: await import('./app/api/collect/oauth/check/route.ts'),
        finish: await import('./app/api/collect/oauth/finish/route.ts'),
        cancel: await import('./app/api/collect/oauth/cancel/route.ts'),
        verify: await import('./app/api/verify-now/route.ts'),
      }
      const bodies = {
        start: { provider: 'codex' },
        check: { provider: 'grok', state: 'state' },
        finish: { provider: 'codex', redirect_url: 'http://localhost/callback?state=state' },
        cancel: { provider: 'codex', state: 'state' },
        verify: {},
      }
      const call = async (name, origin, contentType, body) => {
        const request = new NextRequest('https://hub.example.test/api/' + name, {
          method: 'POST',
          headers: { origin, 'content-type': contentType },
          body,
        })
        const response = await routes[name].POST(request)
        return { status: response.status, body: await response.json() }
      }

      const blocked = {}
      for (const name of Object.keys(routes)) {
        blocked[name] = await call(
          name,
          'https://evil.example.test',
          'text/plain',
          JSON.stringify(bodies[name]),
        )
      }
      const blockedCalls = { ...calls }

      resetCalls()
      const allowed = {}
      for (const name of Object.keys(routes)) {
        allowed[name] = await call(
          name,
          'https://hub.example.test',
          'Application/JSON; Charset=UTF-8',
          JSON.stringify(bodies[name]),
        )
      }
      const allowedCalls = { ...calls }

      resetCalls()
      const malformed = []
      const invalidBodies = ['{', 'null', '[]', '"codex"', '42', 'true']
      for (const name of ['start', 'check', 'finish', 'cancel']) {
        for (const body of invalidBodies) {
          malformed.push({ name, body, response: await call(
            name,
            'https://hub.example.test',
            'application/json',
            body,
          ) })
        }
      }

      console.log(JSON.stringify({
        blocked,
        blockedCalls,
        allowed,
        allowedCalls,
        malformed,
        malformedCalls: { ...calls },
      }))
    `,
    {
      APP_BASE_URL: 'https://hub.example.test',
      TRUST_FORWARDED_HEADERS: 'false',
    },
  ) as {
    blocked: Record<string, { status: number; body: { error?: { code?: string } } }>
    blockedCalls: Record<string, number>
    allowed: Record<string, { status: number }>
    allowedCalls: Record<string, number>
    malformed: Array<{
      name: string
      body: string
      response: { status: number; body: { error?: { code?: string } } }
    }>
    malformedCalls: Record<string, number>
  }

  assert.deepEqual(result.blockedCalls, {
    userAuth: 0,
    adminAuth: 0,
    start: 0,
    check: 0,
    finish: 0,
    cancel: 0,
    verify: 0,
  })
  for (const route of ['start', 'check', 'finish', 'cancel']) {
    assert.equal(result.blocked[route].status, 400, route)
    assert.equal(result.blocked[route].body.error?.code, 'INVALID_REQUEST', route)
  }
  assert.equal(result.blocked.verify.status, 400)

  assert.deepEqual(result.allowedCalls, {
    userAuth: 4,
    adminAuth: 1,
    start: 1,
    check: 1,
    finish: 1,
    cancel: 1,
    verify: 1,
  })
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.allowed).map(([route, response]) => [route, response.status])),
    { start: 200, check: 202, finish: 200, cancel: 200, verify: 200 },
  )

  assert.equal(result.malformed.length, 24)
  for (const entry of result.malformed) {
    assert.equal(entry.response.status, 400, `${entry.name}: ${entry.body}`)
    assert.equal(entry.response.body.error?.code, 'INVALID_REQUEST', `${entry.name}: ${entry.body}`)
  }
  assert.deepEqual(
    {
      start: result.malformedCalls.start,
      check: result.malformedCalls.check,
      finish: result.malformedCalls.finish,
      cancel: result.malformedCalls.cancel,
    },
    { start: 0, check: 0, finish: 0, cancel: 0 },
  )
})
