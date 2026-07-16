import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// P1c 补充（codex review 发现）：真实 cpamp 的 auth-files 可能用显式 `provider` 字段
// 标识 provider，而文件名不带前缀（如 auth-a.json）。normFile 必须依次认
// provider 字段 / type 字段 / 文件名前缀，否则合法新号被 findNew 误报重复且不被隔离。
//
// 走真实客户端路径：MOCK=false + 桩 fetch（env 在 import 时读取，先设好再动态 import）。
// 不触 DB / 不触真实网络 / 不触 data/ 下任何文件。
// ============================================================================

let cpa: typeof import('../lib/cpa.ts').cpa
let findNew: typeof import('../lib/cpa.ts').findNew

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'k'
  ;({ cpa, findNew } = await import('../lib/cpa.ts'))
})

test('真实客户端：auth-files 显式 provider 字段（文件名无前缀）也能识别，findNew 不误报重复', async () => {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/v0/management/auth-files')) {
      return new Response(
        JSON.stringify({
          files: [
            { name: 'auth-a.json', provider: 'codex', account_id: 'acct-123' },
            { name: 'auth-b.json', provider: 'anthropic', account_id: 'acct-456' },
            { name: 'auth-c.json', account_id: 'acct-789' }, // 无任何 provider 线索 → 仍应跳过
          ],
        }),
        { status: 200 },
      )
    }
    throw new Error('测试桩：不该请求 ' + u)
  }) as typeof fetch

  const files = await cpa.listAuthFiles()
  assert.equal(files[0].provider, 'codex')
  assert.equal(files[1].provider, 'claude') // anthropic 归一化为 claude
  assert.equal(files[2].provider, undefined)

  // codex review 的复现场景：修复前这里 duplicate=true（合法新号被误拒）
  const found = await findNew(cpa, 'codex', new Set<string>())
  assert.equal(found.duplicate, false)
  assert.equal(found.accountId, 'acct-123')
  assert.equal(found.authFileName, 'auth-a.json')

  // 识别不出 provider 的文件对任何 provider 都不可见（保守跳过不变）
  const grok = await findNew(cpa, 'grok', new Set<string>())
  assert.equal(grok.duplicate, true)
})
