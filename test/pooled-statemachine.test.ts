import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'
import type { ProbeResult } from '../lib/cpa.ts'

// ============================================================================
// P2-R1（换引擎 v4 第一刀，⚠️ 破坏性）：拆考察期 → v4 简化 5 态 + 首检直接入池。两部分：
//   Part A —— migration 007（破坏性）：verify_status 6 态→5 态映射（observing/granted→pooled、
//             failed→stopped，余不变）、行数不丢、版本到最新；并验「旧 7 态经 005→007 全链」终值。
//             直接驱动 migrate/up，用内存库。
//   Part B —— 首检入池（走 lib/collect.ts processPending，MOCK、单例连接）：claude/grok 直接入池；
//             codex 走 cpamp inspect —— ok/retry→入池（不发分）、reject→退回（删行释放唯一键）、
//             reauth→needs_review。processPending 本单不发任何分（按日计量＝R2）。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指向临时目录再动态 import；绝不碰真实 data/。
//   codex 各 decision 用「桩掉 cpa.inspect 返回指定 ProbeResult」确定性覆盖（mock inspect 仅出 ok/reject）。
// ============================================================================

// ---------------------------- Part A：migration 007（内存库）----------------------------

const count = (d: DatabaseSync): number =>
  (d.prepare('SELECT COUNT(*) AS n FROM contributions').get() as { n: number }).n

// 建到指定版本的内存库（跑 migrations 1..target 的 up + stamp schema_version=target）
function makeDbAt(target: number): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const m of migrations.filter((m) => m.version <= target).sort((a, b) => a.version - b.version)) {
    m.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(target)
  return d
}

// baseline 17 列 INSERT（004/006 追加列可空、留默认 null）；verify_status 由参数给
const INSERT = `INSERT INTO contributions
   (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
    verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
   VALUES (?, ?, 'u', ?, 'e@example.com', 'codex', 'plus', 'oauth', 'f.json', ?, 0, 'none', '', '', NULL, 100, 100)`

// ① migration 007：现役 6 态逐一映射到 v4 5 态、行数不丢、版本到最新（含 007）
test('迁移007：6 态→5 态（observing/granted→pooled、failed→stopped、余不变）、行数不丢、版本到最新', () => {
  assert.ok(migrations.some((m) => m.version === 7), '应存在 migration 007')
  const d = makeDbAt(6) // stamped v6 → migrate 只跑 007
  const mapping: Record<string, string> = {
    submitted: 'submitted',
    first_check: 'first_check',
    observing: 'pooled', // 考察中 → 在池计量
    granted: 'pooled', // 已发分不再是终态 → 回到在池
    failed: 'stopped', // 已失败 → 已停用
    needs_review: 'needs_review',
  }
  const olds = Object.keys(mapping)
  const ins = d.prepare(INSERT)
  olds.forEach((s, i) => ins.run(`r${i}`, i + 1, `acc-${i}`, s))
  const before = count(d)

  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)

  olds.forEach((s, i) => {
    const row = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get(`r${i}`) as {
      verify_status: string
    }
    assert.equal(row.verify_status, mapping[s], `${s} 应迁为 ${mapping[s]}`)
  })
  assert.equal(count(d), before) // 纯 UPDATE，行数守恒
  assert.equal(count(d), olds.length)
  const sv = d.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)
  d.close()
})

// ② 全链（旧 7 态 → 005 → 007）：验证 005 与 007 组合后的终值（生产实际跑的链路）
test('迁移链 005→007：active→pooled、rejected/duplicate→stopped、pending→submitted 等、行数不丢', () => {
  const d = makeDbAt(4) // stamped v4 → migrate 跑 005+006+007
  const mapping: Record<string, string> = {
    pending: 'submitted',
    verifying: 'first_check',
    active: 'pooled', // active→(005)granted→(007)pooled
    rejected: 'stopped', // rejected→(005)failed→(007)stopped
    quarantined: 'first_check', // quarantined→(005)first_check→(007 不变)
    reauth: 'needs_review',
    duplicate: 'stopped', // duplicate→(005)failed→(007)stopped
  }
  const olds = Object.keys(mapping)
  const ins = d.prepare(INSERT)
  olds.forEach((s, i) => ins.run(`c${i}`, i + 1, `chain-${i}`, s))
  const before = count(d)

  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)

  olds.forEach((s, i) => {
    const row = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get(`c${i}`) as {
      verify_status: string
    }
    assert.equal(row.verify_status, mapping[s], `${s} 全链应迁为 ${mapping[s]}`)
  })
  assert.equal(count(d), before)
  d.close()
})

// ---------------------------- Part B：首检入池（单例连接 / MOCK）----------------------------

let db: typeof import('../lib/db.ts').db
let collect: typeof import('../lib/collect.ts')
let cpa: typeof import('../lib/cpa.ts').cpa
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

// 桩掉 cpa.inspect（同一模块单例，collect.ts 看到的是同一对象）返回指定 probes，跑完必还原——
// mock inspect 仅出 ok/reject，桩它才能确定性覆盖 retry/reauth。
async function withInspect<T>(probes: ProbeResult[], fn: () => Promise<T>): Promise<T> {
  const orig = cpa.inspect
  cpa.inspect = async () => probes
  try {
    return await fn()
  } finally {
    cpa.inspect = orig
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-pool-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  collect = await import('../lib/collect.ts')
  ;({ cpa } = await import('../lib/cpa.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ③ claude：cpamp 无深度巡检，OAuth 成功即视为能用 → 首检直接入池 pooled；本单不发分
test('claude 首检 → 直接入池 pooled，不发分（balance 0）', async () => {
  const uid = 6001
  const id = 'claude-pool'
  db.insertUnique(
    makeContribution({ id, provider: 'claude', accountId: 'claude-acc', authFileName: 'claude-f.json', plan: 'pro', linuxdoId: uid }),
  )
  await collect.processPending()
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'pooled')
  assert.equal(db.balance(uid), 0) // R1 不发任何分
})

// ④ grok：同 claude，直接入池
test('grok 首检 → 直接入池 pooled，不发分', async () => {
  const uid = 6002
  const id = 'grok-pool'
  db.insertUnique(
    makeContribution({ id, provider: 'grok', accountId: 'grok-acc', authFileName: 'grok-f.json', plan: 'super', linuxdoId: uid }),
  )
  await collect.processPending()
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'pooled')
  assert.equal(db.balance(uid), 0)
})

// ⑤ codex ok → 入池 pooled，不发分
test('codex 首检 ok → 入池 pooled，不发分（balance 0）', async () => {
  const uid = 6003
  const id = 'codex-ok'
  const accountId = 'codex-ok-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  await withInspect([{ accountId, decision: 'ok', plan: 'plus', reason: 'ok' }], () => collect.processPending())
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'pooled')
  assert.equal(db.balance(uid), 0)
})

// ⑥ codex retry（限额/额度暂满，§3.2「限额不算失败」）→ 入池 pooled，不发分
test('codex 首检 retry（限额不算失败）→ 入池 pooled，不发分', async () => {
  const uid = 6004
  const id = 'codex-retry'
  const accountId = 'codex-retry-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  await withInspect([{ accountId, decision: 'retry', plan: 'plus', reason: 'usage_limit' }], () =>
    collect.processPending(),
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'pooled')
  assert.equal(db.balance(uid), 0)
})

// ⑦ codex reject（401/封号＝首检失败）→ 退回：删 contribution 行、唯一键释放可重插（§2.4/§3.2）
test('codex 首检 reject → 退回：删行、(provider,account_id) 唯一键释放可重交', async () => {
  const uid = 6005
  const id = 'codex-reject'
  const accountId = 'codex-reject-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  await withInspect([{ accountId, decision: 'reject', plan: 'plus', reason: 'unauthorized' }], () =>
    collect.processPending(),
  )
  // 行被删（首检失败不占唯一键）
  assert.equal(db.byUser(uid).find((x) => x.id === id), undefined)
  // 唯一键已释放：同 (codex, accountId) 可重新插入（用户修好重交）
  const reins = db.insertUnique(
    makeContribution({ id: 'codex-reject-again', provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  assert.equal(reins.duplicate, false)
  assert.equal(db.balance(uid), 0)
})

// ⑧ codex reauth（OAuth 失效需重授权）→ needs_review
test('codex 首检 reauth → needs_review', async () => {
  const uid = 6006
  const id = 'codex-reauth'
  const accountId = 'codex-reauth-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  await withInspect([{ accountId, decision: 'reauth', plan: 'plus', reason: 'relogin' }], () =>
    collect.processPending(),
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'needs_review')
  assert.equal(db.balance(uid), 0)
})

// ⑨ pooled 号本单不再处理：入池后多轮 processPending 仍 pooled、余额岿然不动（不发分＝R2）
test('pooled 号不被再处理：多轮 processPending 仍 pooled、balance 0', async () => {
  const uid = 6007
  const id = 'pool-stable'
  db.insertUnique(
    makeContribution({ id, provider: 'grok', accountId: 'grok-stable-acc', authFileName: 'grok-stable.json', plan: 'super', linuxdoId: uid }),
  )
  await collect.processPending() // → pooled
  assert.equal(db.byUser(uid).find((x) => x.id === id)?.verifyStatus, 'pooled')

  await collect.processPending() // pooled 不在拉取集（['submitted','first_check']），不动
  await collect.processPending()
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'pooled')
  assert.equal(db.balance(uid), 0)
})
