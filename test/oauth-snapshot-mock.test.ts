import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionUser } from '../lib/session.ts'

// ============================================================================
// P1b-4（mock 侧）：快照生命周期（db 方法往返/清理）+ mock 流程安全。
// mock 的 finishOAuth/checkOAuth 走 mockCreate 不调 findNew，快照对 mock 无实义，但 collect 层仍会
// 在 startOAuth 存快照、finish 后删快照——本文件确保这套读写在 mock 流程下不报错（诚实标注要求）。
//
// ⚠️ 隔离红线：DB_PATH 与 MOCK_CPA_PATH 双双指向临时目录，再动态 import；绝不碰真实 data/。
// MOCK=true 下 openDb 自动 migrate 到最新（v3），oauth_snapshots 表就绪。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let collect: typeof import('../lib/collect.ts')
let tmpDir: string

function user(id: number): SessionUser {
  return { id, username: `u${id}`, trustLevel: 3 }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-p1b4m-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  collect = await import('../lib/collect.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// 安全会话生命周期：租约 + snapshot 建立，operation claim 后按 fencing token 完成并释放。
test('安全会话生命周期：建立、claim、完成后 snapshot 与 provider lease 一并释放', () => {
  assert.equal(db.getOAuthSnapshot('never'), null) // 缺失键 → null
  const now = Date.now()
  assert.equal(db.acquireOAuthProviderLease({
    provider: 'codex', linuxdoId: 1, leaseToken: 'lease-s1', now, expiresAt: now + 60_000,
  }), true)
  assert.equal(db.createOAuthSession({
    state: 's1', fileNames: ['a.json', 'b.json'], linuxdoId: 1, provider: 'codex',
    leaseToken: 'lease-s1', createdAt: now, expiresAt: now + 60_000,
  }), true)
  assert.deepEqual(db.getOAuthSnapshot('s1'), ['a.json', 'b.json']) // 往返
  const claim = db.claimOAuthSession({
    state: 's1', provider: 'codex', linuxdoId: 1, operationToken: 'op-s1',
    now: now + 1, operationExpiresAt: now + 30_000,
  })
  assert.equal(claim.status, 'claimed')
  assert.equal(db.completeOAuthSession('s1', 'lease-s1', 'op-s1'), true)
  assert.equal(db.getOAuthSnapshot('s1'), null)
  assert.equal(db.acquireOAuthProviderLease({
    provider: 'codex', linuxdoId: 2, leaseToken: 'lease-next', now: now + 2, expiresAt: now + 60_002,
  }), true)
  assert.equal(db.releaseOAuthProviderLease('codex', 'lease-next'), true)
})

// 过期清理同时清 snapshot 与 lease，保留未过期的另一 provider 会话。
test('OAuth 会话清理：删过期 snapshot/lease，保留未过期会话', () => {
  assert.equal(db.acquireOAuthProviderLease({
    provider: 'claude', linuxdoId: 3, leaseToken: 'lease-old', now: 100, expiresAt: 150,
  }), true)
  assert.equal(db.createOAuthSession({
    state: 'old', fileNames: ['x.json'], linuxdoId: 3, provider: 'claude', leaseToken: 'lease-old',
    createdAt: 100, expiresAt: 150,
  }), true)
  assert.equal(db.acquireOAuthProviderLease({
    provider: 'grok', linuxdoId: 4, leaseToken: 'lease-fresh', now: 100, expiresAt: 300,
  }), true)
  assert.equal(db.createOAuthSession({
    state: 'fresh', fileNames: ['y.json'], linuxdoId: 4, provider: 'grok', leaseToken: 'lease-fresh',
    createdAt: 100, expiresAt: 300,
  }), true)
  db.cleanupOAuthSessions(200)
  assert.equal(db.getOAuthSnapshot('old'), null)
  assert.deepEqual(db.getOAuthSnapshot('fresh'), ['y.json'])
})

// mock 流程安全：startOAuth 存快照、finishOAuth 完成并清快照，全程不因快照读写报错
test('mock 流程：startOAuth 存快照、finishOAuth 完成并清快照，不报错', async () => {
  const uid = 5001
  const start = await collect.startOAuth(user(uid), 'codex') // mock 返回 state；collect 授权前存快照
  assert.ok(start.state, 'mock startOAuth 应返回 state')
  assert.notEqual(db.getOAuthSnapshot(start.state), null) // 快照已存（mock 号池为空则存 []）

  const cbUrl = `https://app/callback?state=${start.state}`
  const r = await collect.finishOAuth(user(uid), 'codex', cbUrl) // mock 走 mockCreate，不调 findNew
  if (!r.ok) assert.fail(`mock finishOAuth 应成功，却报错：${r.error}`)
  assert.equal(db.getOAuthSnapshot(start.state), null) // 入库成功后快照删
})
