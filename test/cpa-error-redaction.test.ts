import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// §8 CPA 报错脱敏：cpamp HTTP 原文（响应体 / 完整 URL / 内部 API 路径）与 get-auth-status
// 的 error 字段既不透传前端，也不进入服务端日志；日志只留固定操作分类/状态码。
//
// 走真实客户端路径：MOCK=false + 桩 fetch（env 在 import 时读取，先设好再动态 import）。
// 与 MOCK=true 测试**分文件**（env.mock 每进程固定一次）。不触 DB / 不触真实网络。
//   ① req() 脱敏（任何 cpamp 非 2xx → 中性常量）；
//   ② 上传失败脱敏（auth-files 上传非 2xx → 中性常量，响应体不透传）；
//   ③ get-auth-status 的 cpamp error 字段脱敏（→ 中性「授权失败」）；
//   ④ 反向：保留类业务提示（RT 无效）不被脱敏成中性常量。
// ============================================================================

let cpa: typeof import('../lib/cpa.ts').cpa
let CPA_UNAVAILABLE: string

// 桩响应体里塞「像密钥/内部路径的原文」，断言它绝不出现在对外 message
const LEAK = 'INTERNAL cpamp secret path /etc/xxx tok_leak'

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

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'k'
  const mod = await import('../lib/cpa.ts')
  cpa = mod.cpa
  CPA_UNAVAILABLE = mod.CPA_UNAVAILABLE
})

// ① req()：cpamp 500 响应原文不进 Error.message，抛中性常量
test('① req() 脱敏：cpamp 500 响应原文不透传，抛中性常量', async () => {
  let sawSignal = false
  globalThis.fetch = (async (_input, init) => {
    sawSignal = init?.signal instanceof AbortSignal
    return new Response(LEAK, { status: 500 })
  }) as typeof fetch
  // listAuthFiles 经 req('GET', '/v0/management/auth-files')
  const captured = await capture(() => cpa.listAuthFiles())
  const err = captured.error
  assert.ok(err, '应抛错')
  assert.equal(err.message, CPA_UNAVAILABLE)
  assert.ok(!err.message.includes('tok_leak'), '不含响应体原文')
  assert.ok(!err.message.includes('/etc/xxx'), '不含内部路径')
  assert.ok(!err.message.includes('500'), '不含状态码')
  assert.ok(!err.message.includes('/v0/management'), '不含内部 API 路径')
  assert.equal(sawSignal, true, 'CPA 管理请求必须带 AbortSignal')
  assert.equal(captured.logs.includes(LEAK), false, '响应体不得进入日志')
  assert.equal(captured.logs.includes('/v0/management'), false, '内部路径不得进入日志')
})

// ② 上传失败：cpamp auth-files 500 响应原文不透传（RT 换 token 先成功 → 进到上传步骤）
test('② 上传失败脱敏：cpamp auth-files 500 响应原文不透传，抛中性常量', async () => {
  const idPayload = Buffer.from(JSON.stringify({ account_id: 'acct-red', email: 'e@example.com' })).toString('base64')
  const idToken = `h.${idPayload}.s`
  const signaled: string[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method || 'GET').toUpperCase()
    if (init?.signal instanceof AbortSignal) signaled.push(u.includes('auth.openai.com') ? 'token' : 'upload')
    if (u.includes('auth.openai.com/oauth/token')) {
      // RT 换 token 成功 → 解析出 accountId → 进入上传
      return new Response(JSON.stringify({ access_token: 'a', id_token: idToken, refresh_token: 'r' }), { status: 200 })
    }
    if (u.endsWith('/v0/management/auth-files') && method === 'POST') {
      return new Response(LEAK, { status: 500 }) // 上传失败，响应体含「原文」
    }
    throw new Error('测试桩：不该请求 ' + method + ' ' + u)
  }) as typeof fetch

  const captured = await capture(() => cpa.ingestRefreshToken('rt-xxx', []))
  const err = captured.error
  assert.ok(err, '应抛错')
  assert.equal(err.message, CPA_UNAVAILABLE)
  assert.ok(!err.message.includes('tok_leak'), '不含响应体原文')
  assert.ok(!err.message.includes('500'), '不含状态码')
  assert.deepEqual(signaled.sort(), ['token', 'upload'], 'RT exchange 与 auth-file upload 都必须带 AbortSignal')
  assert.equal(captured.logs.includes(LEAK), false, '上传响应体不得进入日志')
  assert.equal(captured.logs.includes('rt-xxx'), false, 'RT 不得进入日志')
})

// ③ get-auth-status 的 cpamp error 字段脱敏：device 轮询 error 分支 → 对外中性「授权失败」
test('③ s.error 脱敏：get-auth-status 返回 cpamp error 原文 → 对外中性「授权失败」', async () => {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('/v0/management/get-auth-status')) {
      return new Response(JSON.stringify({ status: 'error', error: LEAK }), { status: 200 })
    }
    throw new Error('测试桩：不该请求 ' + u)
  }) as typeof fetch

  const captured = await capture(() => cpa.checkOAuth('grok', 'st-x', [], new Set<string>()))
  const r = captured.value
  assert.ok(r)
  assert.equal(r.status, 'error')
  if (r.status === 'error') {
    assert.ok(!r.error.includes('tok_leak'), 'cpamp error 原文不透传')
    assert.equal(r.error, '授权失败')
  }
  assert.equal(captured.logs.includes(LEAK), false, 'get-auth-status error 字段不得进入日志')
})

// ④ 反向：保留类业务提示（RT 无效）不被脱敏——仍给「Refresh Token 无效或已过期」而非中性常量
test('④ 保留业务提示：RT 无效仍给「Refresh Token 无效或已过期」，未被过度中性化', async () => {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('auth.openai.com/oauth/token')) return new Response('bad', { status: 401 })
    throw new Error('测试桩：不该请求 ' + u)
  }) as typeof fetch

  const err = await cpa.ingestRefreshToken('rt-bad', []).then(() => null, (e) => e as Error)
  assert.ok(err, '应抛错')
  assert.ok(err.message.includes('Refresh Token'), '业务提示保留')
  assert.notEqual(err.message, CPA_UNAVAILABLE)
})

test('⑤ redirect OAuth 瞬态 4xx 保持可重试；明确 status=error 才标记 terminal', async () => {
  for (const status of [408, 425, 429]) {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.endsWith('/v0/management/oauth-callback')) {
        return new Response(LEAK, { status })
      }
      throw new Error('测试桩：不该请求 ' + u)
    }) as typeof fetch
    const callback4xx = await capture(() =>
      cpa.finishOAuth('codex', `https://app/callback?state=retry-${status}`, [], new Set<string>()),
    )
    assert.equal(callback4xx.error?.message, CPA_UNAVAILABLE)
    assert.notEqual((callback4xx.error as Error & { oauthTerminal?: boolean }).oauthTerminal, true)
    assert.equal(callback4xx.logs.includes(LEAK), false)
  }

  let calls = 0
  globalThis.fetch = (async (url: unknown) => {
    calls++
    const u = String(url)
    if (u.endsWith('/v0/management/oauth-callback')) return new Response('{}', { status: 200 })
    if (u.includes('/v0/management/get-auth-status')) {
      return new Response(JSON.stringify({ status: 'error', error: LEAK }), { status: 200 })
    }
    throw new Error('测试桩：不该请求 ' + u)
  }) as typeof fetch
  const statusError = await capture(() =>
    cpa.finishOAuth('codex', 'https://app/callback?state=terminal-status', [], new Set<string>()),
  )
  assert.equal((statusError.error as Error & { oauthTerminal?: boolean }).oauthTerminal, true)
  assert.equal(calls, 2)
  assert.equal(statusError.logs.includes(LEAK), false)
})

test('⑥ JSON 读取空 body fail-closed；明确无返回体的 mutation 仍可成功', async () => {
  for (const body of ['', '{}', '{"files":null}']) {
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch
    const list = await capture(() => cpa.listAuthFiles())
    assert.equal(list.error?.message, CPA_UNAVAILABLE)
    assert.match(list.logs, /cpa\.(management_get invalid_json|auth_files_list invalid_shape)/)
  }

  globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch
  const mutation = await capture(() => cpa.setDisabled('safe-test-file.json', true))
  assert.equal(mutation.error, undefined)
})
