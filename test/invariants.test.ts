import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Contribution } from '../lib/db.ts'

// ⚠️ 测试库隔离（红线）：lib/db.ts 是全局单例连接，DB_PATH 默认硬编码到真实 data/app.db。
// 这里先把 DB_PATH 指向临时目录，再动态 import lib/db.ts，绝不读写真实开发库。
// node --test 每个测试文件是独立进程，env 改动不外泄。
let db: typeof import('../lib/db.ts').db
let tmpDir: string

function makeContribution(over: Partial<Contribution>): Contribution {
  const now = Date.now()
  return {
    id: 'id-' + Math.random().toString(16).slice(2),
    linuxdoId: 1,
    username: 'u',
    accountId: 'acc',
    email: 'e@example.com',
    provider: 'codex',
    plan: 'plus',
    method: 'oauth',
    authFileName: 'f.json',
    verifyStatus: 'submitted',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-inv-'))
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  ;({ db } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ① 去重：同一 account_id 第二次插入 → duplicate，表里仍只 1 行
test('去重：同一 account_id 第二次 insertUnique 返回 duplicate，表内仅一行', () => {
  const accountId = 'dedup-acc'
  const r1 = db.insertUnique(makeContribution({ id: 'dedup-1', accountId, linuxdoId: 9001 }))
  const r2 = db.insertUnique(makeContribution({ id: 'dedup-2', accountId, linuxdoId: 9001 }))
  assert.equal(r1.duplicate, false)
  assert.equal(r2.duplicate, true)
  const mine = db.byUser(9001).filter((c) => c.accountId === accountId)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].id, 'dedup-1') // 保留第一条
})

// ② 发分幂等：同一 (reason, ref) 调两次 → 余额只加一次
test('发分幂等：同一 (reason, ref) awardPoints 两次，余额只加一次', () => {
  const uid = 9002
  const base = db.balance(uid)
  const a1 = db.awardPoints(uid, 15, 'contribution', 'award-ref-1')
  const a2 = db.awardPoints(uid, 15, 'contribution', 'award-ref-1')
  assert.equal(a1, true) // 首次入账
  assert.equal(a2, false) // 幂等：第二次不入账
  assert.equal(db.balance(uid), base + 15)
})

// ③ 原子扣分：余额不足拒绝且不变；余额够扣成功且只扣一次
test('原子扣分：余额不足拒绝且不变；余额够只扣一次', () => {
  const uid = 9003
  db.awardPoints(uid, 30, 'seed', 'spend-seed') // 余额=30
  const fail = db.spendPoints(uid, 50, 'redeem', 'spend-fail')
  assert.equal(fail, false)
  assert.equal(db.balance(uid), 30) // 不足未扣
  const ok = db.spendPoints(uid, 20, 'redeem', 'spend-ok')
  assert.equal(ok, true)
  assert.equal(db.balance(uid), 10) // 只扣一次
})

// ④ 状态转移：仅当当前状态 ∈ from 才成功；不匹配不改状态（需求 §3.2 v4 五态）
test('状态转移：仅当当前状态∈from 才成功；不匹配不改状态', () => {
  const id = 'trans-1'
  db.insertUnique(
    makeContribution({ id, accountId: 'trans-acc', linuxdoId: 9004, verifyStatus: 'submitted' }),
  )
  // 当前 submitted，from=['first_check'] 不匹配 → 失败，状态不变
  const noMatch = db.transition(id, ['first_check'], 'pooled')
  assert.equal(noMatch, false)
  const afterNoMatch = db.byUser(9004).find((c) => c.id === id)
  assert.ok(afterNoMatch)
  assert.equal(afterNoMatch.verifyStatus, 'submitted')
  // from=['submitted'] 匹配 → 成功，状态变 first_check
  const ok = db.transition(id, ['submitted'], 'first_check')
  assert.equal(ok, true)
  const afterOk = db.byUser(9004).find((c) => c.id === id)
  assert.ok(afterOk)
  assert.equal(afterOk.verifyStatus, 'first_check')
})

// ⑤ 终身账本：一号一辈子只发一次分（worker 重试/重入不得重复发分）
// §3.1/§3.6：唯一号一辈子只发一次分；contributions 一号一行=永久账本永不删除；
// awardPoints 幂等（UNIQUE(reason,ref)，ref=contribution.id）锁死重入不重复入账。
test('终身账本：一号一辈子只发一次分（awardPoints 重入幂等、账本行稳定）', () => {
  const uid = 9005
  const cid = 'terminal-ledger'
  const pts = 20
  const base = db.balance(uid)

  // 落一个唯一号（复合唯一键 provider+account_id）
  const ins = db.insertUnique(
    makeContribution({ id: cid, accountId: 'terminal-acc', linuxdoId: uid, provider: 'claude', plan: 'pro' }),
  )
  assert.equal(ins.duplicate, false)

  // 首次发分（mirror grant()：幂等发分 + 落 reward 字段）→ 入账，余额 +pts
  assert.equal(db.awardPoints(uid, pts, 'contribution', cid), true)
  db.update(cid, { points: pts, rewardStatus: 'granted' })
  assert.equal(db.balance(uid), base + pts)
  const afterFirst = db.byUser(uid).find((c) => c.id === cid)
  assert.ok(afterFirst)

  // worker 重试/重入：同一 (reason='contribution', ref=cid) 二次发分尝试
  assert.equal(db.awardPoints(uid, pts, 'contribution', cid), false) // 幂等：不再入账
  assert.equal(db.balance(uid), base + pts) // 余额只加一次，岿然不动

  // 账本行不因二次发分尝试而变化；points / rewardStatus 等 reward 字段稳定
  const afterSecond = db.byUser(uid).find((c) => c.id === cid)
  assert.deepEqual(afterSecond, afterFirst)
})
