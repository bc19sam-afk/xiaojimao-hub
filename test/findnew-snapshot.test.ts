import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import type { AuthFile, CpaClient } from '../lib/cpa.ts'

// ============================================================================
// P1b-3：修 findNew「抢注号池既有号」（codex xhigh review 于 PR #8 发现的生产安全缺陷）。
// cpamp 号池官方号/贡献号共用，池里本就有一堆不属于 hub（不在 known）的号。用户完成 OAuth 后，
// 修复前 findNew 可能命中池中某个既有号 → 记到提交者名下、isolate() 禁用该生产号、错发分。
// 修法：授权动作**之前**给 auth-files 拍快照（记下已存在文件名），findNew 只认快照外的新文件。
//
//   ① 核心回归：快照挡住池中既有号，只认新落文件；
//   ② 反证：无快照（before 空）会中招——证明快照是关键防线；
//   ③ 向后兼容：before 空时 provider 过滤 + known 判重仍与原 findNew 一致；
//   ④ 端到端：真实 redirect 链（MOCK=false + 桩 fetch），整条链只认授权后新增号。
//
// 走真实客户端路径：MOCK=false + 桩 fetch（env 在 import 时读取，先设好再动态 import）。
// 不触 DB / 不触真实网络 / 不触 data/ 下任何文件。
// ============================================================================

let findNew: typeof import('../lib/cpa.ts').findNew
let cpa: typeof import('../lib/cpa.ts').cpa

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'k'
  ;({ findNew, cpa } = await import('../lib/cpa.ts'))
})

// findNew 只用到 client.listAuthFiles
function stubClient(files: AuthFile[]): CpaClient {
  return { listAuthFiles: async () => files } as unknown as CpaClient
}
function authFile(over: Partial<AuthFile>): AuthFile {
  return { name: 'f.json', accountId: 'acc', email: '', plan: 'pro', disabled: true, provider: 'claude', ...over }
}

// 号池既有 claude 号（授权前就在池里、不属于 hub）与用户刚授权落的新号。
// poolA 故意排在 newB **前面**：.find 取首个匹配，无快照时会先命中 poolA（见 ②）。
const poolA = authFile({ name: 'anthropic-poolA.json', accountId: 'acct-poolA', disabled: false })
const newB = authFile({ name: 'anthropic-newB.json', accountId: 'acct-newB' })

// ① 核心回归：授权前快照 {poolA} 挡住号池既有号，findNew 只返回快照外的新文件 newB。
test('① 核心回归：before 快照挡住号池既有号，findNew 只返回新落文件', async () => {
  const client = stubClient([poolA, newB])
  const r = await findNew(client, 'claude', new Set<string>(), new Set([poolA.name]))
  assert.equal(r.duplicate, false)
  assert.equal(r.accountId, 'acct-newB')
  assert.equal(r.authFileName, 'anthropic-newB.json')
  assert.notEqual(r.accountId, 'acct-poolA') // 绝不抢注池中既有号
})

// ② 反证：同一文件池、同一顺序，若 before 为空（旧行为）→ findNew 命中池中既有号 poolA。
//    证明「快照」正是关键防线：唯一变量就是有没有快照。
test('② 反证：无快照（before 空）会抢注号池既有号 poolA', async () => {
  const client = stubClient([poolA, newB])
  const r = await findNew(client, 'claude', new Set<string>(), new Set<string>())
  assert.equal(r.accountId, 'acct-poolA') // 没有快照就中招（正是本单要修的）
})

// ③ 向后兼容：before 空时，provider 过滤 + known 判重仍与原 findNew 一致。
test('③ 向后兼容：空 before 下 provider 过滤与 known 判重仍生效', async () => {
  const known = authFile({ name: 'anthropic-known.json', accountId: 'acct-known' })
  const codex = authFile({ name: 'codex-x.json', accountId: 'acct-codex', provider: 'codex' })
  const fresh = authFile({ name: 'anthropic-fresh.json', accountId: 'acct-fresh' })
  const client = stubClient([known, codex, fresh])

  // known 含 acct-known → 跳过；codex 非目标 provider → 跳过；只剩 claude 的 fresh
  const r = await findNew(client, 'claude', new Set<string>(['acct-known']), new Set<string>())
  assert.equal(r.duplicate, false)
  assert.equal(r.accountId, 'acct-fresh')

  // 全部已知/被过滤 → duplicate（保守，与原行为一致）
  const none = await findNew(client, 'claude', new Set<string>(['acct-known', 'acct-fresh']), new Set<string>())
  assert.equal(none.duplicate, true)
  assert.equal(none.accountId, '')
})

// ④ 端到端（真实 redirect 链）：P1b-4 后 cpa.finishOAuth 不再自拍快照，改用调用方传入的授权前快照
//    （collect 层从按 state 持久化的快照读出）。授权后 auth-files=[poolA, newB]、传入快照={poolA}，
//    findNew 只认快照外的 newB。证明整条链只认授权后新增号，不抢注池中 poolA。
test('④ 端到端：redirect 链用调用方传入的授权前快照，只认新增号不抢注 poolA', async () => {
  let listCalls = 0
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method || 'GET').toUpperCase()
    if (u.endsWith('/v0/management/auth-files') && method === 'GET') {
      listCalls++
      // 授权后 auth-files：poolA（池中既有）+ newB（本次授权新落）。快照不再由 finishOAuth 自拍。
      // claude 号稳定 ID 在 account 字段（normFile 对 claude 采纳 account 作 accountId）。
      const files = [
        { name: 'anthropic-poolA.json', provider: 'anthropic', account: 'acct-poolA' },
        { name: 'anthropic-newB.json', provider: 'anthropic', account: 'acct-newB' },
      ]
      return new Response(JSON.stringify({ files }), { status: 200 })
    }
    if (u.endsWith('/v0/management/oauth-callback') && method === 'POST') {
      return new Response('{}', { status: 200 })
    }
    if (u.includes('/v0/management/get-auth-status')) {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    }
    throw new Error('测试桩：不该请求 ' + method + ' ' + u)
  }) as typeof fetch

  // 调用方传入授权前快照 {poolA}（P1b-4：由 startOAuth 拍、按 state 持久化，此处模拟已读出后传入）
  const before = new Set(['anthropic-poolA.json'])
  const r = await cpa.finishOAuth('claude', 'https://app/callback?state=st-p1b3', [], before)
  assert.equal(r.duplicate, false)
  assert.equal(r.accountId, 'acct-newB')
  assert.equal(r.authFileName, 'anthropic-newB.json')
  assert.notEqual(r.accountId, 'acct-poolA') // 池中既有号绝不被当新号
  assert.equal(listCalls, 1) // 快照移到 startOAuth/collect 层，finishOAuth 内只剩一次 findNew 的 list
})
