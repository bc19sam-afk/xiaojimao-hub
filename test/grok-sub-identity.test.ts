import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// P1b-2：grok 稳定 account_id 落地。2026-07-16 扒 CLIProxyAPI 源码
// internal/auth/xai/token.go 确认：xai 走全套 OIDC（scope 含 openid + id_token），
// TokenStorage 有顶层 `sub`（OIDC subject），是稳定唯一标识、与 email 平级。修复前
// normFile 只读 account_id/accountId（+claude 的 account 兜底），grok 号（无 account_id、
// 身份在 sub）accountId 落空 → collect.recordIngest 判「认不出」，真实 grok 号入不了库。
// 此处证明 sub 被采纳为 accountId，且兜底严格按 provider 划界（sub 仅限 grok）。
//
// 走真实客户端路径：MOCK=false + 桩 fetch（env 在 import 时读取，先设好再动态 import），
// cpa.listAuthFiles() 内部即调 normFile。不触 DB / 不触真实网络 / 不触 data/ 下任何文件。
// ============================================================================

let cpa: typeof import('../lib/cpa.ts').cpa

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'k'
  ;({ cpa } = await import('../lib/cpa.ts'))
})

// 桩 fetch：仅回应 auth-files 列表，返回给定 RawFile 数组
function stubAuthFiles(files: unknown[]): void {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/v0/management/auth-files')) {
      return new Response(JSON.stringify({ files }), { status: 200 })
    }
    throw new Error('测试桩：不该请求 ' + u)
  }) as typeof fetch
}

// 任务1：grok 号仅有 sub（无 account_id）→ sub 被采纳为稳定 accountId
test('grok：auth-file 仅有 sub（OIDC subject）时采纳为 accountId', async () => {
  stubAuthFiles([{ name: 'xai-x.json', provider: 'xai', sub: 'grok-sub-abc' }])
  const files = await cpa.listAuthFiles()
  assert.equal(files[0].provider, 'grok') // xai 归一化为 grok
  assert.equal(files[0].accountId, 'grok-sub-abc') // 修复前为空 → recordIngest 判「认不出」
})

// 任务1（对称 P1b-1 account 仅限 claude 的教训）：sub 兜底严格仅限 grok。
// claude 带 sub 但无 account/account_id、codex 带 sub 无 account_id，都缺 canonical identity。
// 严格边界不再把残缺行降成 accountId='' 后继续消费，而是整批 fail-closed。
test('sub 仅限 grok：claude/codex 只有 sub 时整批 fail-closed', async () => {
  stubAuthFiles([
    { name: 'anthropic-c.json', provider: 'anthropic', sub: 'should-not-win-claude' },
    { name: 'codex-d.json', provider: 'codex', sub: 'should-not-win-codex' },
  ])
  await assert.rejects(() => cpa.listAuthFiles(), /账号服务暂时不可用/)
})

// 任务1：grok 号同时有 account_id 与 sub → account_id 优先（兜底链不改既有优先级）
test('grok：同时有 account_id 与 sub → account_id 优先', async () => {
  stubAuthFiles([{ name: 'xai-e.json', provider: 'xai', account_id: 'acct-grok-1', sub: 'sub-should-lose' }])
  const files = await cpa.listAuthFiles()
  assert.equal(files[0].provider, 'grok')
  assert.equal(files[0].accountId, 'acct-grok-1')
})
