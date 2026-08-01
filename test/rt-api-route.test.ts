import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = process.cwd()

function runIsolated(script: string) {
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
        APP_BASE_URL: 'https://hub.example.test',
        TRUST_FORWARDED_HEADERS: 'false',
        MOCK: 'true',
        WORKER_ENABLED: 'false',
        SESSION_SECRET: 'x'.repeat(64),
      },
    },
  )

  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout) as unknown
}

test('RT mutation route rejects untrusted or malformed requests before auth and ingest', () => {
  const result = runIsolated(String.raw`
    import { mock } from 'node:test'

    const calls = { auth: 0, ingest: 0 }
    let authenticated = true
    let receivedRt = ''
    let outcome = { kind: 'success' }
    const logs = []
    const originalError = console.error
    console.error = (...args) => logs.push(args.map(String).join(' '))
    const reset = () => {
      calls.auth = 0
      calls.ingest = 0
      authenticated = true
      receivedRt = ''
      outcome = { kind: 'success' }
      logs.length = 0
    }

    mock.module(new URL('./lib/session.ts', import.meta.url), {
      exports: {
        getCurrentUser: async () => {
          calls.auth++
          return authenticated ? { id: 1, username: 'route-test', trustLevel: 4 } : null
        },
      },
    })
    mock.module(new URL('./lib/collect.ts', import.meta.url), {
      exports: {
        ingestRT: async (_user, rt) => {
          calls.ingest++
          receivedRt = rt
          if (outcome.kind === 'throw') throw outcome.error
          if (outcome.kind === 'result') return outcome.value
          return { ok: true, contribution: { id: 'rt-route-success' } }
        },
      },
    })

    const { NextRequest } = await import('next/server')
    const route = await import('./app/api/collect/rt/route.ts')
    const call = async ({
      origin = 'https://hub.example.test',
      contentType = 'application/json',
      body = JSON.stringify({ refresh_token: 'refresh-token-ok' }),
    } = {}) => {
      try {
        const request = new NextRequest('https://hub.example.test/api/collect/rt', {
          method: 'POST',
          headers: { origin, 'content-type': contentType },
          body,
        })
        const response = await route.POST(request)
        return { status: response.status, body: await response.json() }
      } catch (error) {
        return { threw: true, error: error instanceof Error ? error.message : String(error) }
      }
    }

    const invalidInputs = [
      ['sibling-origin', { origin: 'https://evil.example.test' }],
      ['text-plain', { contentType: 'text/plain' }],
      ['malformed-json', { body: '{' }],
      ['null', { body: 'null' }],
      ['array', { body: '[]' }],
      ['top-level-string', { body: '"refresh-token"' }],
      ['number', { body: '42' }],
      ['boolean', { body: 'true' }],
      ['missing-field', { body: '{}' }],
      ['null-field', { body: '{"refresh_token":null}' }],
      ['number-field', { body: '{"refresh_token":123}' }],
      ['boolean-field', { body: '{"refresh_token":true}' }],
      ['array-field', { body: '{"refresh_token":[]}' }],
      ['object-field', { body: '{"refresh_token":{}}' }],
      ['blank-field', { body: '{"refresh_token":"   "}' }],
    ]
    const invalid = []
    for (const [label, request] of invalidInputs) {
      reset()
      invalid.push({ label, response: await call(request), calls: { ...calls } })
    }

    reset()
    const allowed = await call({
      contentType: 'Application/JSON; Charset=UTF-8',
      body: JSON.stringify({ refresh_token: '  refresh-token-trimmed  ' }),
    })
    const allowedCalls = { ...calls, receivedRt }

    reset()
    authenticated = false
    const unauthenticated = await call()
    const unauthenticatedCalls = { ...calls }

    const fixedOutcomes = []
    for (const [label, value] of [
      ['duplicate', { ok: false, code: 'DUPLICATE_ACCOUNT', error: 'secret-duplicate' }],
      ['busy', { ok: false, code: 'PROVIDER_BUSY', error: 'secret-busy' }],
      ['cpa-result', { ok: false, code: 'CPA_UNAVAILABLE', error: 'secret-cpa-result' }],
    ]) {
      reset()
      outcome = { kind: 'result', value }
      fixedOutcomes.push({ label, response: await call(), calls: { ...calls }, logs: [...logs] })
    }

    const thrownOutcomes = []
    for (const [label, error] of [
      ['invalid-rt', new Error('Refresh Token 无效或已过期')],
      ['cpa-unavailable', new Error('账号服务暂时不可用，请稍后重试')],
      ['unknown', new Error('SQLITE path=/private/app.db token=lease-secret')],
    ]) {
      reset()
      outcome = { kind: 'throw', error }
      thrownOutcomes.push({ label, response: await call(), calls: { ...calls }, logs: [...logs] })
    }

    console.error = originalError
    console.log(JSON.stringify({
      invalid,
      allowed,
      allowedCalls,
      unauthenticated,
      unauthenticatedCalls,
      fixedOutcomes,
      thrownOutcomes,
    }))
  `) as {
    invalid: Array<{
      label: string
      response: { status?: number; body?: { error?: string }; threw?: boolean; error?: string }
      calls: { auth: number; ingest: number }
    }>
    allowed: { status: number; body: { message: string } }
    allowedCalls: { auth: number; ingest: number; receivedRt: string }
    unauthenticated: { status: number; body: { error: string } }
    unauthenticatedCalls: { auth: number; ingest: number }
    fixedOutcomes: Array<{
      label: string
      response: { status: number; body: { error: string } }
      calls: { auth: number; ingest: number }
      logs: string[]
    }>
    thrownOutcomes: Array<{
      label: string
      response: { status: number; body: { error: string } }
      calls: { auth: number; ingest: number }
      logs: string[]
    }>
  }

  for (const entry of result.invalid) {
    assert.equal(entry.response.threw, undefined, entry.label)
    assert.equal(entry.response.status, 400, entry.label)
    assert.equal(entry.response.body?.error, '请求无效', entry.label)
    assert.deepEqual(entry.calls, { auth: 0, ingest: 0 }, entry.label)
  }

  assert.equal(result.allowed.status, 200)
  assert.deepEqual(result.allowedCalls, { auth: 1, ingest: 1, receivedRt: 'refresh-token-trimmed' })
  assert.equal(result.unauthenticated.status, 401)
  assert.deepEqual(result.unauthenticatedCalls, { auth: 1, ingest: 0 })

  assert.deepEqual(
    result.fixedOutcomes.map(({ label, response }) => ({ label, status: response.status, error: response.body.error })),
    [
      { label: 'duplicate', status: 409, error: '这个账号已贡献过' },
      { label: 'busy', status: 409, error: '该类型已有授权正在进行，请稍后再试' },
      { label: 'cpa-result', status: 503, error: '账号服务暂时不可用，请稍后重试' },
    ],
  )
  for (const entry of result.fixedOutcomes) {
    assert.deepEqual(entry.calls, { auth: 1, ingest: 1 }, entry.label)
    assert.deepEqual(entry.logs, [], entry.label)
    assert.equal(entry.response.body.error.includes('secret-'), false, entry.label)
  }

  assert.deepEqual(
    result.thrownOutcomes.map(({ label, response }) => ({ label, status: response.status, error: response.body.error })),
    [
      { label: 'invalid-rt', status: 502, error: 'Refresh Token 无效或已过期' },
      { label: 'cpa-unavailable', status: 503, error: '账号服务暂时不可用，请稍后重试' },
      { label: 'unknown', status: 502, error: '提交失败' },
    ],
  )
  const unknown = result.thrownOutcomes.find((entry) => entry.label === 'unknown')
  assert.ok(unknown)
  assert.deepEqual(unknown.logs, ['[collect-rt] ingest_failed'])
  assert.equal(JSON.stringify(unknown).includes('/private/app.db'), false)
  assert.equal(JSON.stringify(unknown).includes('lease-secret'), false)
  for (const entry of result.thrownOutcomes) {
    assert.deepEqual(entry.calls, { auth: 1, ingest: 1 }, entry.label)
  }
})

test('RT route keeps guard, strict body parsing, auth, and ingest in fail-closed order', () => {
  const source = fs.readFileSync(path.join(root, 'app/api/collect/rt/route.ts'), 'utf8')
  const guardAt = source.indexOf('isSameOriginJsonMutation(req)')
  const parseAt = source.indexOf('await parseRTRequestBody(req)')
  const authAt = source.indexOf('await getCurrentUser()')
  const ingestAt = source.indexOf('await ingestRT(')

  assert.ok(guardAt >= 0, 'RT route must use the shared same-origin JSON mutation guard')
  assert.ok(parseAt > guardAt, 'RT route must parse only after the mutation guard')
  assert.ok(authAt > parseAt, 'malformed RT bodies must stop before authentication')
  assert.ok(ingestAt > authAt, 'RT ingestion must run only after authentication')
  assert.doesNotMatch(source, /String\(body\.refresh_token/)
  assert.doesNotMatch(source, /\(e as Error\)\.message/)
})
