import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { AuthFile, CpaClient } from '../lib/cpa.ts'
import type { SessionUser } from '../lib/session.ts'

// ============================================================================
// P1b-4：授权前快照按 OAuth state 持久化跨请求，修 P1b-3 遗留的两处残留：
//   ① retry 孤立回退：finishOAuth 落号后、入库前失败重试 → 单请求重新拍快照会把上次落的号
//      当「既有」过滤掉 → duplicate → 号未入库未隔离、孤立在池。持久化快照（startOAuth 拍、
//      retry 读同一份）根治：before 永远是授权前的 {poolA}，retry 仍认出 newB。
//   ② device 抢注：checkOAuth 跨请求拿不到授权前快照，旧代码传空 before → 可能抢注号池既有号。
//      改读持久化快照后挡住。
//
// 本文件走**真实客户端路径**（MOCK=false + 桩 fetch）以真正驱动 findNew（mock 的 finishOAuth/
// checkOAuth 走 mockCreate 不调 findNew，无法覆盖 before 过滤）。db 用临时库：MOCK=false 下 openDb
// 只校验版本不迁移，故先把临时库预迁移到最新再 import。绝不碰真实 data/ 下任何文件。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let findNew: typeof import('../lib/cpa.ts').findNew
let collect: typeof import('../lib/collect.ts')
let tmpDir: string

function user(id: number): SessionUser {
  return { id, username: `u${id}`, trustLevel: 3 }
}
// findNew 直连桩（只用到 listAuthFiles）
function stubClient(files: AuthFile[]): CpaClient {
  return { listAuthFiles: async () => files } as unknown as CpaClient
}
function authFile(over: Partial<AuthFile>): AuthFile {
  return { name: 'f.json', accountId: 'acc', email: '', plan: 'pro', disabled: true, provider: 'claude', ...over }
}

function seedOAuthSession(
  linuxdoId: number,
  provider: 'codex' | 'claude' | 'grok',
  state: string,
  fileNames: string[],
): void {
  const now = Date.now()
  const leaseToken = `lease-${state}`
  assert.equal(
    db.acquireOAuthProviderLease({ provider, linuxdoId, leaseToken, now, expiresAt: now + 900_000 }),
    true,
  )
  assert.equal(
    db.createOAuthSession({
      state,
      fileNames,
      linuxdoId,
      provider,
      leaseToken,
      createdAt: now,
      expiresAt: now + 900_000,
      hardExpiresAt: now + 900_000,
      authorizationUrl: `https://example.test/${state}`,
      flow: provider === 'grok' ? 'device' : 'redirect',
    }),
    true,
  )
}

// 真实客户端 fetch 桩：auth-files GET 返回给定文件；oauth-callback / get-auth-status / 状态 PATCH 各自应答。
// 返回一个读 auth-files GET 次数的取值器，用于断言 finishOAuth「非重新拍快照」（只应有一次 findNew 的 list）。
function installFetch(files: unknown[]): () => number {
  let listCalls = 0
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method || 'GET').toUpperCase()
    if (u.endsWith('/v0/management/auth-files') && method === 'GET') {
      listCalls++
      return new Response(JSON.stringify({ files }), { status: 200 })
    }
    if (u.endsWith('/v0/management/oauth-callback') && method === 'POST') {
      return new Response('{}', { status: 200 })
    }
    if (u.includes('/v0/management/get-auth-status')) {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    }
    if (u.includes('/v0/management/auth-files/status') && method === 'PATCH') {
      return new Response('{}', { status: 200 }) // isolate() 的 setDisabled
    }
    throw new Error('测试桩：不该请求 ' + method + ' ' + u)
  }) as typeof fetch
  return () => listCalls
}

// ---- 迁移测试辅助（独立内存库，不碰全局单例）----
const INSERT_CONTRIB = `INSERT INTO contributions
   (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
    verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
   VALUES (?, ?, 'u', ?, 'e@example.com', ?, 'plus', 'oauth', 'f.json', 'pending', 0, 'none', '', '', NULL, 100, 100)`

function tableNames(d: DatabaseSync): Set<string> {
  const rows = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}
function currentVersion(d: DatabaseSync): number {
  return (d.prepare('SELECT version FROM schema_version').get() as unknown as { version: number }).version
}
// 手动跑 001+002 造一个 v2 库（用 migrations 数组的 up，不复制建表 SQL），登记 version=2
function makeV2Db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const m of migrations.filter((m) => m.version <= 2).sort((a, b) => a.version - b.version)) m.up(d)
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (2)').run()
  return d
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-p1b4-'))
  const dbPath = path.join(tmpDir, 'app.db')
  // MOCK=false 下 openDb 只校验 schema 版本、不迁移；先把临时库预迁移到最新（v3）再 import
  const seed = new DatabaseSync(dbPath)
  migrate(seed)
  seed.close()
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'k'
  process.env.DB_PATH = dbPath
  ;({ db } = await import('../lib/db.ts'))
  ;({ findNew } = await import('../lib/cpa.ts'))
  collect = await import('../lib/collect.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── 迁移 003 ──────────────────────────────────────────────────────────────

// 空库 migrate → 最新，且 oauth_snapshots 表在、可用（003 在通往最新版的链路上建表）
test('迁移：空库 migrate → 最新，oauth_snapshots 表建好可用', () => {
  const d = new DatabaseSync(':memory:')
  const version = migrate(d)
  assert.equal(version, LATEST_VERSION) // 003 的 oauth_snapshots 在通往最新版的链路上建好
  assert.ok(tableNames(d).has('oauth_snapshots'), '应建 oauth_snapshots 表')
  // 结构可用：state 主键、file_names、created_at
  d.prepare('INSERT INTO oauth_snapshots (state, file_names, created_at) VALUES (?,?,?)').run('s', '["a.json"]', 1)
  const got = d.prepare('SELECT file_names FROM oauth_snapshots WHERE state=?').get('s') as unknown as {
    file_names: string
  }
  assert.equal(got.file_names, '["a.json"]')
  d.close()
})

// v2 旧库（P1a 后有数据）migrate → 最新：加 oauth_snapshots、原数据不丢（003 是首个「新增功能表」迁移，向后兼容）
test('迁移：v2 旧库（有数据）migrate → 最新，加 oauth_snapshots、原 contributions 不丢', () => {
  const d = makeV2Db()
  d.prepare(INSERT_CONTRIB).run('v2row', 42, 'accV2', 'codex') // v2 已有一行贡献
  assert.equal(currentVersion(d), 2)
  assert.ok(!tableNames(d).has('oauth_snapshots'), '前置：v2 不应有 oauth_snapshots')

  const version = migrate(d)
  assert.equal(version, LATEST_VERSION)
  assert.ok(tableNames(d).has('oauth_snapshots'), 'migrate 后应加上 oauth_snapshots')

  // 原 contributions 数据不丢（003 只加表、不碰 contributions）
  const row = d.prepare('SELECT account_id, linuxdo_id FROM contributions WHERE id=?').get('v2row') as unknown as {
    account_id: string
    linuxdo_id: number
  }
  assert.equal(row.account_id, 'accV2')
  assert.equal(row.linuxdo_id, 42)
  // schema_version 单行 = 最新
  const sv = d.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)
  d.close()
})

// ── retry 安全（核心）────────────────────────────────────────────────────

// 第二次 finishOAuth 读持久化快照 {poolA}（非重新拍）→ findNew 仍认出 newB → 入库、不孤立。
test('retry 安全：第二次 finishOAuth 读持久化快照 {poolA}（非重新拍），认出 newB 并入库、不孤立', async () => {
  const uid = 4001
  const state = 'st-retry-1'
  const cbUrl = `https://app/callback?state=${state}`

  // 模拟 startOAuth 已按 state 存快照 {poolA}（授权前池里只有 poolA）
  seedOAuthSession(uid, 'claude', state, ['anthropic-poolA.json'])
  // 「第一次授权落 newB 但入库前失败、未删快照」直接构造：快照仍在、池里已是 poolA + newB
  const listCalls = installFetch([
    { name: 'anthropic-poolA.json', provider: 'anthropic', account: 'acct-poolA' },
    { name: 'anthropic-newB.json', provider: 'anthropic', account: 'acct-newB' },
  ])

  const r = await collect.finishOAuth(user(uid), 'claude', cbUrl)
  if (!r.ok) assert.fail(`retry 应成功入库（不孤立），却报错：${r.error}`)
  assert.equal(r.contribution.accountId, 'acct-newB') // 认出授权新落号（非池中 poolA）
  assert.equal(r.contribution.provider, 'claude')

  // 若 finishOAuth 曾重新拍快照，before 会含 newB → duplicate → r.ok=false；成功即证明读的是持久化快照
  assert.equal(listCalls(), 1) // 只一次 findNew 的 list，无授权后重新拍

  // newB 已入库（不孤立在池里）
  assert.equal(db.byUser(uid).filter((c) => c.accountId === 'acct-newB').length, 1)
  // 成功入库后快照已删
  assert.equal(db.getOAuthSnapshot(state), null)
})

// 对比断言：若按 P1b-3 单请求「授权后重新拍快照」，before 含 newB → findNew 判 duplicate → 号孤立。
test('retry 对比：授权后重新拍快照（before 含 newB）会把 newB 判成既有 → duplicate（正是本单要修的孤立）', async () => {
  const client = stubClient([
    authFile({ name: 'anthropic-poolA.json', accountId: 'acct-poolA', provider: 'claude' }),
    authFile({ name: 'anthropic-newB.json', accountId: 'acct-newB', provider: 'claude' }),
  ])
  // 授权后重新拍＝池里已有 poolA+newB → before={poolA,newB}
  const dup = await findNew(client, 'claude', new Set<string>(), new Set(['anthropic-poolA.json', 'anthropic-newB.json']))
  assert.equal(dup.duplicate, true) // newB 落进重拍的快照 → 被当既有 → duplicate
  assert.equal(dup.authFileName, '') // isolate('') 空转、recordIngest 判失败 → newB 孤立在池
})

// ── device 覆盖 ─────────────────────────────────────────────────────────

// checkOAuth 读持久化快照 {poolC} 作 before → 挡住池中 poolC、只认新号 newD。
test('device 覆盖：checkOAuth 读持久化快照 {poolC}，挡住池中 poolC、认新号 newD 入库', async () => {
  const uid = 4002
  const state = 'st-device-1'
  seedOAuthSession(uid, 'grok', state, ['xai-poolC.json']) // startOAuth 授权前存的快照
  installFetch([
    { name: 'xai-poolC.json', provider: 'xai', account_id: 'acct-poolC' },
    { name: 'xai-newD.json', provider: 'xai', account_id: 'acct-newD' },
  ])

  const r = await collect.checkOAuth(user(uid), 'grok', state)
  assert.equal(r.done, true)
  if (!r.done) return
  if (!r.result.ok) assert.fail(`device 应成功入库，却报错：${r.result.error}`)
  assert.equal(r.result.contribution.accountId, 'acct-newD')
  assert.equal(r.result.contribution.provider, 'grok')
  assert.notEqual(r.result.contribution.accountId, 'acct-poolC') // 池中既有号绝不被抢注
  assert.equal(db.getOAuthSnapshot(state), null) // 成功入库后快照删
})

test('OAuth 多 fresh 候选整体拒绝：旧文件与并发 RT 均零隔离、零错误归属', async () => {
  const uid = 4006
  const state = 'st-multi-fresh-zero-write'
  seedOAuthSession(uid, 'codex', state, ['codex-old.json'])

  let isolateCalls = 0
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    const method = (init?.method || 'GET').toUpperCase()
    if (target.endsWith('/v0/management/auth-files') && method === 'GET') {
      return new Response(JSON.stringify({
        files: [
          { name: 'codex-old.json', provider: 'codex', account_id: 'old-account' },
          { name: 'codex-rt-race.json', provider: 'codex', account_id: 'rt-account' },
          { name: 'codex-oauth-intended.json', provider: 'codex', account_id: 'oauth-account' },
        ],
      }), { status: 200 })
    }
    if (target.endsWith('/v0/management/oauth-callback') && method === 'POST') {
      return new Response('{}', { status: 200 })
    }
    if (target.includes('/v0/management/get-auth-status')) {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    }
    if (target.includes('/v0/management/auth-files/status') && method === 'PATCH') {
      isolateCalls++
      return new Response('{}', { status: 200 })
    }
    throw new Error(`测试桩：不该请求 ${method} ${target}`)
  }) as typeof fetch

  const result = await collect.finishOAuth(
    user(uid),
    'codex',
    `https://app/callback?state=${state}`,
  )

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'CPA_UNAVAILABLE')
  assert.equal(isolateCalls, 0)
  assert.equal(db.byUser(uid).length, 0)
  assert.deepEqual(db.getOAuthSnapshot(state), ['codex-old.json'])
})

// 即使调用方错误地传空 before，只要出现多个无法因果区分的 fresh 候选也必须整体拒绝，
// 不能再按列表顺序抢注池中 poolC。
test('device 防线：空 before 且多 fresh 候选时 fail-closed，不抢注池中既有号', async () => {
  const client = stubClient([
    authFile({ name: 'xai-poolC.json', accountId: 'acct-poolC', provider: 'grok' }),
    authFile({ name: 'xai-newD.json', accountId: 'acct-newD', provider: 'grok' }),
  ])
  const result = await findNew(client, 'grok', new Set<string>(), new Set<string>())
  assert.equal(result.accountId, '')
  assert.equal(result.authFileName, '')
  assert.equal(result.duplicate, true)
})

// ── fail-closed：快照缺失即拒绝（codex xhigh 于 PR #10 指出）─────────────────
// 静默降级空 before ＝ 完全退化回抢注号池既有号的旧行为。触发面：入库成功已删快照但响应丢失后的
// 重试、快照过期被清理、部署前发起的授权。真实模式必须拒绝并引导重新发起授权；且拒绝要发生在
// oauth-callback 之前（否则号已落、又必孤立）。

// finishOAuth：快照缺失 → 拒绝，且绝不触发任何 CPA 请求（callback 前拦下）
test('fail-closed：finishOAuth 快照缺失即拒绝，不触发 oauth-callback', async () => {
  const uid = 4003
  const state = 'st-missing-1' // 从未 setOAuthSnapshot（模拟已消费/过期/部署前发起）
  let touched = 0
  globalThis.fetch = (async () => {
    touched++
    throw new Error('fail-closed 下不该有任何 CPA 请求')
  }) as typeof fetch

  const r = await collect.finishOAuth(user(uid), 'claude', `https://app/callback?state=${state}`)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /重新点击「发起授权」/)
  assert.equal(touched, 0) // callback 之前就拦下——号不会孤立
  assert.equal(db.byUser(uid).length, 0) // 未入任何库
})

// checkOAuth（device）：快照缺失 → done:false + 错误提示，同样不触发 CPA 请求
test('fail-closed：checkOAuth 快照缺失即拒绝，不触发 CPA 请求', async () => {
  const uid = 4004
  let touched = 0
  globalThis.fetch = (async () => {
    touched++
    throw new Error('fail-closed 下不该有任何 CPA 请求')
  }) as typeof fetch

  const r = await collect.checkOAuth(user(uid), 'grok', 'st-missing-2')
  assert.equal(r.done, false)
  if (!r.done) assert.match(r.error ?? '', /重新点击「发起授权」/)
  assert.equal(touched, 0)
})

// 入库成功删快照后，同 state 重试（响应丢失场景）→ 被 fail-closed 拒绝，绝不抢注池中号
test('fail-closed：成功入库删快照后同 state 重试被拒绝，不退化为抢注', async () => {
  const uid = 4005
  const state = 'st-consumed-1'
  const cbUrl = `https://app/callback?state=${state}`
  seedOAuthSession(uid, 'claude', state, ['anthropic-poolA.json'])
  installFetch([
    { name: 'anthropic-poolA.json', provider: 'anthropic', account: 'acct-poolA' },
    { name: 'anthropic-newE.json', provider: 'anthropic', account: 'acct-newE' },
  ])

  const first = await collect.finishOAuth(user(uid), 'claude', cbUrl)
  if (!first.ok) assert.fail(`首次应成功：${first.error}`)
  assert.equal(db.getOAuthSnapshot(state), null) // 快照已消费删除

  // 响应丢失，用户重试同一回调 URL：快照已无 → 拒绝（修复前：空 before → 抢注 poolA）
  const retry = await collect.finishOAuth(user(uid), 'claude', cbUrl)
  assert.equal(retry.ok, false)
  if (!retry.ok) assert.match(retry.error, /重新点击「发起授权」/)
  // poolA 从未被记到任何人名下
  assert.equal(db.byUser(uid).filter((c) => c.accountId === 'acct-poolA').length, 0)
})
