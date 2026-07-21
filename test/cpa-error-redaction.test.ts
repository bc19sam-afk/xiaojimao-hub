import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// §8 CPA 报错脱敏：cpamp HTTP 原文（状态码 / 响应体 / 内部 API 路径）与 get-auth-status
// 的 error 字段绝不透传前端——对外只给中性文案，原文只进服务端日志。
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
  globalThis.fetch = (async () => new Response(LEAK, { status: 500 })) as typeof fetch
  // listAuthFiles 经 req('GET', '/v0/management/auth-files')
  const err = await cpa.listAuthFiles().then(() => null, (e) => e as Error)
  assert.ok(err, '应抛错')
  assert.equal(err.message, CPA_UNAVAILABLE)
  assert.ok(!err.message.includes('tok_leak'), '不含响应体原文')
  assert.ok(!err.message.includes('/etc/xxx'), '不含内部路径')
  assert.ok(!err.message.includes('500'), '不含状态码')
  assert.ok(!err.message.includes('/v0/management'), '不含内部 API 路径')
})

// ② 上传失败：cpamp auth-files 500 响应原文不透传（RT 换 token 先成功 → 进到上传步骤）
test('② 上传失败脱敏：cpamp auth-files 500 响应原文不透传，抛中性常量', async () => {
  const idPayload = Buffer.from(JSON.stringify({ account_id: 'acct-red', email: 'e@example.com' })).toString('base64')
  const idToken = `h.${idPayload}.s`
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method || 'GET').toUpperCase()
    if (u.includes('auth.openai.com/oauth/token')) {
      // RT 换 token 成功 → 解析出 accountId → 进入上传
      return new Response(JSON.stringify({ access_token: 'a', id_token: idToken, refresh_token: 'r' }), { status: 200 })
    }
    if (u.endsWith('/v0/management/auth-files') && method === 'POST') {
      return new Response(LEAK, { status: 500 }) // 上传失败，响应体含「原文」
    }
    throw new Error('测试桩：不该请求 ' + method + ' ' + u)
  }) as typeof fetch

  const err = await cpa.ingestRefreshToken('rt-xxx', []).then(() => null, (e) => e as Error)
  assert.ok(err, '应抛错')
  assert.equal(err.message, CPA_UNAVAILABLE)
  assert.ok(!err.message.includes('tok_leak'), '不含响应体原文')
  assert.ok(!err.message.includes('500'), '不含状态码')
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

  const r = await cpa.checkOAuth('grok', 'st-x', [], new Set<string>())
  assert.equal(r.status, 'error')
  if (r.status === 'error') {
    assert.ok(!r.error.includes('tok_leak'), 'cpamp error 原文不透传')
    assert.equal(r.error, '授权失败')
  }
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
