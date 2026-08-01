import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

let exchangeCodeForToken: typeof import('../lib/linuxdo.ts').exchangeCodeForToken
let fetchLinuxDoUser: typeof import('../lib/linuxdo.ts').fetchLinuxDoUser
let LINUXDO_UNAVAILABLE: string

const root = path.resolve(import.meta.dirname, '..')

const SECRET = 'linuxdo-secret-response token=abc /private/path'

before(async () => {
  process.env.MOCK = 'true'
  process.env.LINUXDO_CLIENT_ID = 'test-client'
  process.env.LINUXDO_CLIENT_SECRET = 'test-secret'
  process.env.LINUXDO_TOKEN_URL = 'https://linuxdo.test/token/private-url'
  process.env.LINUXDO_USERINFO_URL = 'https://linuxdo.test/user/private-url'
  const module = await import('../lib/linuxdo.ts')
  exchangeCodeForToken = module.exchangeCodeForToken
  fetchLinuxDoUser = module.fetchLinuxDoUser
  LINUXDO_UNAVAILABLE = module.LINUXDO_UNAVAILABLE
})

async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ error?: Error; value?: T; logs: string }> {
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

test('Linux.do token：只接受非空 access_token', async () => {
  let tokenSignal = false
  const valid = await withFetch(
    (async (_input, init) => {
      tokenSignal = init?.signal instanceof AbortSignal
      return new Response(JSON.stringify({ access_token: '  token-ok  ', token_type: 'Bearer' }))
    }) as typeof fetch,
    () => exchangeCodeForToken('code'),
  )
  assert.deepEqual(valid, { access_token: 'token-ok', token_type: 'Bearer' })
  assert.equal(tokenSignal, true, 'Linux.do token exchange 必须带 AbortSignal')

  for (const payload of [{}, [], { access_token: '' }, { access_token: 123 }]) {
    const result = await captureErrors(() =>
      withFetch(
        (async () => new Response(JSON.stringify(payload))) as typeof fetch,
        () => exchangeCodeForToken('code'),
      ),
    )
    assert.equal(result.error?.message, '外部服务请求失败')
    assert.match(result.logs, /linuxdo\.token_exchange invalid_shape/)
  }
})

test('Linux.do userinfo：合法最小身份通过并规整 username', async () => {
  let userinfoSignal = false
  const profile = await withFetch(
    (async (_input, init) => {
      userinfoSignal = init?.signal instanceof AbortSignal
      return new Response(JSON.stringify({ id: 42, username: ' alice ', trust_level: 3, active: true }))
    }) as typeof fetch,
    () => fetchLinuxDoUser('access'),
  )
  assert.equal(profile.id, 42)
  assert.equal(profile.username, 'alice')
  assert.equal(profile.trust_level, 3)
  assert.equal(userinfoSignal, true, 'Linux.do userinfo 必须带 AbortSignal')
})

test('Linux.do userinfo：坏身份、非有限信任等级和 active 非严格 true 全部 fail-closed', async () => {
  const invalid = [
    {},
    [],
    { id: 1, username: 'u', active: true },
    { id: 1, username: 'u', trust_level: null, active: true },
    { id: 0, username: 'u', trust_level: 1 },
    { id: 1.5, username: 'u', trust_level: 1 },
    { id: 1, username: '', trust_level: 1 },
    { id: 1, username: 'u', trust_level: '3' },
    { id: 1, username: 'u', trust_level: -1 },
    { id: 1, username: 'u', trust_level: 1.5 },
    { id: 1, username: 'u', trust_level: 1 },
    { id: 1, username: 'u', trust_level: 1, active: false },
    { id: 1, username: 'u', trust_level: 1, active: null },
    { id: 1, username: 'u', trust_level: 1, active: 'yes' },
  ]
  for (const payload of invalid) {
    const result = await captureErrors(() =>
      withFetch(
        (async () => new Response(JSON.stringify(payload))) as typeof fetch,
        () => fetchLinuxDoUser('access'),
      ),
    )
    assert.equal(result.error?.message, '外部服务请求失败')
    assert.match(result.logs, /linuxdo\.userinfo invalid_shape/)
  }
})

test('Linux.do callback：必须在 userinfo 严格校验后才签发 session cookie', () => {
  const callback = fs.readFileSync(
    path.join(root, 'app/api/auth/linuxdo/callback/route.ts'),
    'utf8',
  )
  const profileAt = callback.indexOf('await fetchLinuxDoUser')
  const signAt = callback.indexOf('await signSession')
  const cookieAt = callback.indexOf('res.cookies.set(SESSION_COOKIE')

  assert.ok(profileAt >= 0 && profileAt < signAt, 'userinfo 校验必须先于 session 签名')
  assert.ok(signAt >= 0 && signAt < cookieAt, 'session cookie 必须只使用校验后的 profile')
  assert.match(callback, /catch\s*\{[\s\S]*return fail\('oauth'\)/, 'userinfo 拒绝必须走失败分支')
})

test('Linux.do HTTP/坏 JSON 错误对外中性，日志不含 URL 或响应体', async () => {
  const http = await captureErrors(() =>
    withFetch(
      (async () => new Response(SECRET, { status: 502 })) as typeof fetch,
      () => exchangeCodeForToken('code'),
    ),
  )
  assert.equal(http.error?.message, LINUXDO_UNAVAILABLE)
  assert.equal(http.logs.includes(SECRET), false)
  assert.equal(http.logs.includes('private-url'), false)

  const badJson = await captureErrors(() =>
    withFetch(
      (async () => new Response(SECRET, { status: 200 })) as typeof fetch,
      () => fetchLinuxDoUser('access'),
    ),
  )
  assert.equal(badJson.error?.message, LINUXDO_UNAVAILABLE)
  assert.equal(badJson.logs.includes(SECRET), false)
  assert.equal(badJson.logs.includes('private-url'), false)
})
