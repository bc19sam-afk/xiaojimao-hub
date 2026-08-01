import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// P1b-1：claude 稳定 account_id 落地。P0-A 实测确认 claude 号的稳定业务 ID 在
// cpamp auth-file 的 `account` 字段（无 account_id）。修复前 normFile 只读
// account_id/accountId，claude 号 accountId 落空 → collect.recordIngest 直接判失败，
// 真实 claude 号根本入不了库。此处证明 account 字段被采纳，且不干扰有 account_id 的号。
//
// 走真实客户端路径：MOCK=false + 桩 fetch（env 在 import 时读取，先设好再动态 import）。
// 不触 DB / 不触真实网络 / 不触 data/ 下任何文件。
// ============================================================================

let cpa: typeof import('../lib/cpa.ts').cpa

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'k'
  ;({ cpa } = await import('../lib/cpa.ts'))
})

test('真实客户端：claude auth-file 仅有 account 字段时采纳为 accountId；有 account_id 者仍优先', async () => {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/v0/management/auth-files')) {
      return new Response(
        JSON.stringify({
          files: [
            // 真实 claude 号：无 account_id，稳定 ID 只在 account 字段（P0-A：len 14）
            { name: 'anthropic-xxx.json', provider: 'anthropic', account: 'acc12345678901' },
            // codex 号：同时有 account_id 与 account → account_id 必须优先，account 不得夺锚
            { name: 'codex-yyy.json', provider: 'codex', account_id: 'acct-codex-1', account: 'should-not-win' },
          ],
        }),
        { status: 200 },
      )
    }
    throw new Error('测试桩：不该请求 ' + u)
  }) as typeof fetch

  const files = await cpa.listAuthFiles()

  // claude：account 字段被采纳为 accountId（修复前为空 → recordIngest 判失败入不了库）
  assert.equal(files[0].provider, 'claude') // anthropic 归一化为 claude
  assert.equal(files[0].accountId, 'acc12345678901')

  // codex：account_id 优先于 account，fallback 链不改既有语义
  assert.equal(files[1].provider, 'codex')
  assert.equal(files[1].accountId, 'acct-codex-1')
})

test('真实客户端：grok 只有非 canonical account 字段时整批 fail-closed', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    files: [{ name: 'xai-zzz.json', provider: 'xai', account: 'grok-unverified' }],
  }), { status: 200 })) as typeof fetch

  await assert.rejects(() => cpa.listAuthFiles(), /账号服务暂时不可用/)
})
