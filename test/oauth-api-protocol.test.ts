import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import {
  oauthClientDisposition,
  oauthErrorCode,
  oauthFailure,
  oauthPending,
  shouldClearOAuthSession,
} from '../lib/oauth-protocol.ts'
import {
  oauthFailureResponse,
  oauthPendingResponse,
  parseOAuthRequestBody,
} from '../lib/oauth-route.ts'

const root = process.cwd()

test('OAuth failures use stable status/code/message/retry fields without ad hoc strings', () => {
  assert.deepEqual(oauthFailure('AUTH_REQUIRED'), {
    status: 401,
    body: {
      ok: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: '请先登录',
        retryable: false,
      },
    },
  })
  assert.deepEqual(oauthFailure('PROVIDER_BUSY'), {
    status: 409,
    body: {
      ok: false,
      error: {
        code: 'PROVIDER_BUSY',
        message: '该类型已有授权正在进行，请稍后再试',
        retryable: true,
        retryAfterMs: 3000,
      },
    },
  })
  assert.deepEqual(oauthFailure('OPERATION_BUSY'), {
    status: 409,
    body: {
      ok: false,
      error: {
        code: 'OPERATION_BUSY',
        message: '授权会话正在处理中，请稍后重试',
        retryable: true,
        retryAfterMs: 3000,
      },
    },
  })
  assert.deepEqual(oauthFailure('DUPLICATE_ACCOUNT'), {
    status: 409,
    body: {
      ok: false,
      error: {
        code: 'DUPLICATE_ACCOUNT',
        message: '这个账号已贡献过',
        retryable: false,
      },
    },
  })
  assert.deepEqual(oauthFailure('OAUTH_SESSION_INVALID'), {
    status: 410,
    body: {
      ok: false,
      error: {
        code: 'OAUTH_SESSION_INVALID',
        message: '授权会话无效或已过期',
        retryable: false,
      },
    },
  })
  assert.deepEqual(oauthFailure('OAUTH_CANCELLED'), {
    status: 410,
    body: {
      ok: false,
      error: {
        code: 'OAUTH_CANCELLED',
        message: '授权会话已取消',
        retryable: false,
      },
    },
  })
  assert.deepEqual(oauthFailure('UPSTREAM_AUTH_REJECTED'), {
    status: 422,
    body: {
      ok: false,
      error: {
        code: 'UPSTREAM_AUTH_REJECTED',
        message: '授权未完成或已被拒绝，请重新发起',
        retryable: false,
      },
    },
  })
  assert.deepEqual(oauthFailure('CPA_UNAVAILABLE'), {
    status: 503,
    body: {
      ok: false,
      error: {
        code: 'CPA_UNAVAILABLE',
        message: '账号服务暂时不可用，请稍后重试',
        retryable: true,
        retryAfterMs: 3000,
      },
    },
  })
  assert.equal(
    oauthErrorCode(Object.assign(new Error('internal detail'), { oauthTerminal: true }), 'CPA_UNAVAILABLE'),
    'UPSTREAM_AUTH_REJECTED',
  )
})

test('device pending and UI dispositions distinguish busy from duplicate and transient from terminal', () => {
  assert.deepEqual(oauthPending(), {
    status: 202,
    body: { ok: true, status: 'pending', retryAfterMs: 3000 },
  })
  assert.equal(oauthClientDisposition('DUPLICATE_ACCOUNT'), 'clear')
  assert.equal(oauthClientDisposition('OPERATION_BUSY'), 'retain')
  assert.equal(oauthClientDisposition('PROVIDER_BUSY'), 'retain')
  assert.equal(oauthClientDisposition('OAUTH_SESSION_INVALID'), 'clear')
  assert.equal(oauthClientDisposition('OAUTH_CANCELLED'), 'clear')
  assert.equal(oauthClientDisposition('UPSTREAM_AUTH_REJECTED'), 'clear')
  assert.equal(oauthClientDisposition('CPA_UNAVAILABLE'), 'retain')
  assert.equal(shouldClearOAuthSession('OAUTH_SESSION_INVALID'), true)
  assert.equal(shouldClearOAuthSession('OAUTH_CANCELLED'), true)
  assert.equal(shouldClearOAuthSession('TRANSITION_CONFLICT'), false)
  assert.equal(shouldClearOAuthSession('CPA_UNAVAILABLE'), false)
})

test('route helpers emit the exact HTTP status and JSON code consumed by the UI', async () => {
  for (const [code, status] of [
    ['DUPLICATE_ACCOUNT', 409],
    ['OPERATION_BUSY', 409],
    ['TRANSITION_CONFLICT', 409],
    ['OAUTH_SESSION_INVALID', 410],
    ['OAUTH_CANCELLED', 410],
    ['CPA_UNAVAILABLE', 503],
  ] as const) {
    const response = oauthFailureResponse(code)
    assert.equal(response.status, status)
    assert.equal((await response.json()).error.code, code)
  }

  const pending = oauthPendingResponse()
  assert.equal(pending.status, 202)
  assert.deepEqual(await pending.json(), {
    ok: true,
    status: 'pending',
    retryAfterMs: 3000,
  })
})

test('OAuth request body parser rejects malformed and non-object JSON before startOAuth', async () => {
  let startOAuthCalls = 0
  const startOAuth = async () => {
    startOAuthCalls++
    return new Response(null, { status: 204 })
  }

  for (const [label, body] of [
    ['malformed JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"codex"'],
    ['number', '42'],
    ['boolean', 'true'],
  ] as const) {
    const request = new NextRequest('http://localhost/api/collect/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const parsed = await parseOAuthRequestBody(request)
    const response = parsed.ok ? await startOAuth() : parsed.response

    assert.equal(response.status, 400, label)
    assert.deepEqual(await response.json(), oauthFailure('INVALID_REQUEST').body, label)
  }

  assert.equal(startOAuthCalls, 0, 'invalid JSON bodies must be rejected before startOAuth')
})

test('OAuth request body parser accepts only a non-null, non-array JSON object', async () => {
  const request = new NextRequest('http://localhost/api/collect/oauth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'codex' }),
  })
  const parsed = await parseOAuthRequestBody(request)

  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.deepEqual(parsed.body, { provider: 'codex' })
})

test('OAuth routes share the protocol helper and expose recovery plus idempotent cancellation', () => {
  for (const route of ['start', 'finish', 'check', 'session', 'cancel']) {
    const source = fs.readFileSync(path.join(root, `app/api/collect/oauth/${route}/route.ts`), 'utf8')
    assert.match(source, /oauthFailureResponse/)
  }
  for (const [route, operation] of [
    ['start', 'startOAuth'],
    ['check', 'checkOAuth'],
    ['finish', 'finishOAuth'],
    ['cancel', 'cancelOAuth'],
  ] as const) {
    const source = fs.readFileSync(path.join(root, `app/api/collect/oauth/${route}/route.ts`), 'utf8')
    const parseAt = source.indexOf('await parseOAuthRequestBody(req)')
    const operationAt = source.indexOf(`await ${operation}(`)
    assert.ok(parseAt >= 0, `${route} must use the shared OAuth request body parser`)
    assert.ok(operationAt > parseAt, `${route} must reject invalid bodies before ${operation}`)
    assert.match(source, /if \(!parsed\.ok\) return parsed\.response/)
    assert.doesNotMatch(source, /req\.json\(/)
  }
  const check = fs.readFileSync(path.join(root, 'app/api/collect/oauth/check/route.ts'), 'utf8')
  assert.match(check, /oauthPendingResponse/)
  const cancel = fs.readFileSync(path.join(root, 'app/api/collect/oauth/cancel/route.ts'), 'utf8')
  assert.match(cancel, /oauthCancelledResponse/)
})

test('CollectPanel binds provider to the recovered session, settles polling, and cancels server-side', () => {
  const panel = fs.readFileSync(path.join(root, 'components/CollectPanel.tsx'), 'utf8')
  assert.match(panel, /provider:\s*Provider/)
  assert.match(panel, /session\.provider/)
  assert.match(panel, /\/api\/collect\/oauth\/session/)
  assert.match(panel, /\/api\/collect\/oauth\/cancel/)
  assert.match(panel, /shouldClearOAuthSession\(code\)/)
  assert.match(panel, /setTimeout/)
  assert.doesNotMatch(panel, /setInterval/)
  const finish = panel.slice(panel.indexOf('async function submitCallback'), panel.indexOf('async function cancelSession'))
  assert.doesNotMatch(finish, /res\.status\s*===\s*409/)
})
