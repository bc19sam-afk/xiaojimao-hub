import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
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

// 快照生命周期：set/get 往返、UPSERT 覆盖、空数组、delete 后为 null、缺失键为 null
test('快照生命周期：set/get 往返、UPSERT 覆盖、delete 后为 null、缺失键为 null', () => {
  assert.equal(db.getOAuthSnapshot('never'), null) // 缺失键 → null
  db.setOAuthSnapshot('s1', ['a.json', 'b.json'])
  assert.deepEqual(db.getOAuthSnapshot('s1'), ['a.json', 'b.json']) // 往返
  db.setOAuthSnapshot('s1', ['c.json']) // 同 state UPSERT 覆盖
  assert.deepEqual(db.getOAuthSnapshot('s1'), ['c.json'])
  db.setOAuthSnapshot('s2', []) // 空数组也能存/取
  assert.deepEqual(db.getOAuthSnapshot('s2'), [])
  db.deleteOAuthSnapshot('s1')
  assert.equal(db.getOAuthSnapshot('s1'), null) // 删后为 null
  assert.deepEqual(db.getOAuthSnapshot('s2'), []) // 不误删其它 key
})

// 快照清理：cleanupOAuthSnapshots 删过期、留新鲜
test('快照清理：cleanupOAuthSnapshots 删过期、留新鲜', async () => {
  db.setOAuthSnapshot('old', ['x.json'])
  await sleep(60) // 拉开 created_at，让 old 明显早于阈值
  db.setOAuthSnapshot('fresh', ['y.json'])
  db.cleanupOAuthSnapshots(30) // 删 30ms 前的：old(~60ms 前)删、fresh(~0ms)留
  assert.equal(db.getOAuthSnapshot('old'), null)
  assert.deepEqual(db.getOAuthSnapshot('fresh'), ['y.json'])
})

// mock 流程安全：startOAuth 存快照、finishOAuth 完成并清快照，全程不因快照读写报错
test('mock 流程：startOAuth 存快照、finishOAuth 完成并清快照，不报错', async () => {
  const uid = 5001
  const start = await collect.startOAuth('codex') // mock 返回 state；collect 授权前存快照
  assert.ok(start.state, 'mock startOAuth 应返回 state')
  assert.notEqual(db.getOAuthSnapshot(start.state), null) // 快照已存（mock 号池为空则存 []）

  const cbUrl = `https://app/callback?state=${start.state}`
  const r = await collect.finishOAuth(user(uid), 'codex', cbUrl) // mock 走 mockCreate，不调 findNew
  if (!r.ok) assert.fail(`mock finishOAuth 应成功，却报错：${r.error}`)
  assert.equal(db.getOAuthSnapshot(start.state), null) // 入库成功后快照删
})
