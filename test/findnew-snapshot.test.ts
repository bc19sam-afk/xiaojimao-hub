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

// ② fail-closed：同一文件池、同一顺序，若 before 为空会出现两个无法因果区分的 fresh 文件。
//    单写者合同被破坏时绝不能按列表顺序猜第一个，否则会抢注池中既有号或并发 RT 文件。
test('② fail-closed：多个 fresh 文件不按列表顺序猜归属', async () => {
  const client = stubClient([poolA, newB])
  const r = await findNew(client, 'claude', new Set<string>(), new Set<string>())
  assert.equal(r.accountId, '')
  assert.equal(r.authFileName, '')
  assert.equal(r.duplicate, true)
})

// ③ 向后兼容：before 过滤旧文件后，provider 过滤 + known 判重仍与原 findNew 一致。
test('③ 向后兼容：before 与 provider 过滤后，唯一 fresh 文件仍可判重', async () => {
  const known = authFile({ name: 'anthropic-known.json', accountId: 'acct-known' })
  const codex = authFile({ name: 'codex-x.json', accountId: 'acct-codex', provider: 'codex' })
  const fresh = authFile({ name: 'anthropic-fresh.json', accountId: 'acct-fresh' })
  const client = stubClient([known, codex, fresh])
  const before = new Set<string>([known.name])

  // known 含 acct-known → 跳过；codex 非目标 provider → 跳过；只剩 claude 的 fresh
  const r = await findNew(client, 'claude', new Set<string>(['acct-known']), before)
  assert.equal(r.duplicate, false)
  assert.equal(r.accountId, 'acct-fresh')

  // 唯一 fresh 已知 → duplicate；accountId 带回已知号身份（重交语义：collect 层报
  // 「这个号交过了」而非「未能确认」），authFileName 留空保证 isolate() 零副作用
  const none = await findNew(client, 'claude', new Set<string>(['acct-known', 'acct-fresh']), before)
  assert.equal(none.duplicate, true)
  assert.equal(none.accountId, 'acct-fresh')
  assert.equal(none.authFileName, '')
})

test('并发 RT 与目标 OAuth 文件同时 fresh 时整体拒绝，零错误归属', async () => {
  const rtRace = authFile({
    name: 'codex-rt-race.json',
    accountId: 'rt-account',
    provider: 'codex',
  })
  const intendedOAuth = authFile({
    name: 'codex-oauth-intended.json',
    accountId: 'oauth-account',
    provider: 'codex',
  })

  const result = await findNew(
    stubClient([rtRace, intendedOAuth]),
    'codex',
    new Set<string>(),
    new Set<string>(),
  )

  assert.deepEqual(result, {
    accountId: '',
    email: '',
    plan: 'unknown',
    authFileName: '',
    duplicate: true,
  })
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

// ── 重交已交过的号（codex xhigh 于 PR #11 指出）───────────────────────────────
// 号被拒/失效后 cpamp 文件已删，用户重新授权 → 落**新文件**（不在快照）但 accountId 已在
// known ＝「已交过的号」。findNew 须带回 accountId（collect 层报「这个号交过了」而非
// 「未能确认」），且 authFileName 留空——绝不能让 isolate() 去禁用池中文件（重交零副作用）。
test('重交已交号：快照外新文件但 accountId 在 known → duplicate 带 accountId、authFileName 空', async () => {
  const client = stubClient([
    authFile({ name: 'anthropic-poolA.json', accountId: 'acct-poolA' }), // 池中既有（在快照）
    authFile({ name: 'anthropic-rejoin2.json', accountId: 'acct-known-1' }), // 重授权新落，但号已交过
  ])
  const r = await findNew(client, 'claude', new Set(['acct-known-1']), new Set(['anthropic-poolA.json']))
  assert.equal(r.duplicate, true)
  assert.equal(r.accountId, 'acct-known-1') // 带回身份 → collect 报「这个号交过了」
  assert.equal(r.authFileName, '') // 留空 → isolate() 空转，不碰池中文件
})

// 快照外同时有「真新号」和「重交号」仍无法证明哪个属于本次 state，必须整体拒绝。
test('重交与真新号并存：多 fresh 候选 fail-closed', async () => {
  const client = stubClient([
    authFile({ name: 'anthropic-rejoin3.json', accountId: 'acct-known-2' }), // 重交（排前面）
    authFile({ name: 'anthropic-brand-new.json', accountId: 'acct-brand-new' }), // 真新号
  ])
  const r = await findNew(client, 'claude', new Set(['acct-known-2']), new Set<string>())
  assert.equal(r.duplicate, true)
  assert.equal(r.accountId, '')
  assert.equal(r.authFileName, '')
})
