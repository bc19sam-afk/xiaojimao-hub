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

// ① migration 007：现役 6 态映射到 v4 5 态；failed 按来源分流（codex bot 于 PR #15 指出）——
//    进过池（observe_start_at 非 null）→ stopped 锁唯一键；从未入池（NULL）→ 删行释放唯一键可重交
test('迁移007：6 态→5 态；failed 分流（进过池→stopped / 未入池→删行释放）、版本到最新', () => {
  assert.ok(migrations.some((m) => m.version === 7), '应存在 migration 007')
  const d = makeDbAt(6) // stamped v6 → migrate 只跑 007
  const mapping: Record<string, string> = {
    submitted: 'submitted',
    first_check: 'first_check',
    observing: 'pooled', // 考察中 → 在池计量
    granted: 'pooled', // 已发分不再是终态 → 回到在池
    needs_review: 'needs_review',
  }
  const olds = Object.keys(mapping)
  const ins = d.prepare(INSERT)
  olds.forEach((s, i) => ins.run(`r${i}`, i + 1, `acc-${i}`, s))
  // failed×2：进过池（observe_start_at 非 null）→ stopped；首检失败未入池（NULL）→ 删行释放
  ins.run('f-pooled', 90, 'acc-f-pooled', 'failed')
  d.prepare('UPDATE contributions SET observe_start_at=123 WHERE id=?').run('f-pooled')
  ins.run('f-prepool', 91, 'acc-f-prepool', 'failed') // observe_start_at 留 NULL
  const before = count(d)

  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)

  olds.forEach((s, i) => {
    const row = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get(`r${i}`) as {
      verify_status: string
    }
    assert.equal(row.verify_status, mapping[s], `${s} 应迁为 ${mapping[s]}`)
  })
  // failed 分流断言
  const fPooled = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get('f-pooled') as {
    verify_status: string
  }
  assert.equal(fPooled.verify_status, 'stopped') // 进过池 → stopped（锁唯一键）
  const gone = d.prepare('SELECT COUNT(*) AS n FROM contributions WHERE id=?').get('f-prepool') as {
    n: number
  }
  assert.equal(gone.n, 0) // 未入池的 failed 行被删＝唯一键释放
  assert.equal(count(d), before - 1) // 行数只减「被释放」那一行
  const sv = d.prepare('SELECT version FROM schema_version').all() as unknown as { version: number }[]
  assert.equal(sv.length, 1)
  assert.equal(sv[0].version, LATEST_VERSION)
  d.close()
})

// ② 全链（旧 7 态 → 005 → 007）：验证 005 与 007 组合后的终值（生产实际跑的链路）
test('迁移链 005→007：active→pooled、pending→submitted 等；rejected/duplicate（未入池）→删行释放', () => {
  const d = makeDbAt(4) // stamped v4 → migrate 跑 005+006+007
  // 保留态（全链后仍在库）
  const kept: Record<string, string> = {
    pending: 'submitted',
    verifying: 'first_check',
    active: 'pooled', // active→(005)granted→(007)pooled（真发过分＝进过池；但 005 未回填 observe_start_at，
    //                     007 只按 failed 分流，granted 不受影响，仍映射 pooled）
    quarantined: 'first_check', // quarantined→(005)first_check→(007 不变)
    reauth: 'needs_review',
  }
  // 释放态：rejected/duplicate→(005)failed 且 observe_start_at NULL（从未入池）→(007)删行释放唯一键
  const released = ['rejected', 'duplicate']
  const olds = [...Object.keys(kept), ...released]
  const ins = d.prepare(INSERT)
  olds.forEach((s, i) => ins.run(`c${i}`, i + 1, `chain-${i}`, s))
  const before = count(d)

  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)

  Object.keys(kept).forEach((s) => {
    const i = olds.indexOf(s)
    const row = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get(`c${i}`) as {
      verify_status: string
    }
    assert.equal(row.verify_status, kept[s], `${s} 全链应迁为 ${kept[s]}`)
  })
  released.forEach((s) => {
    const i = olds.indexOf(s)
    const gone = d.prepare('SELECT COUNT(*) AS n FROM contributions WHERE id=?').get(`c${i}`) as {
      n: number
    }
    assert.equal(gone.n, 0, `${s}（未入池 failed）应被删行释放唯一键`)
  })
  assert.equal(count(d), before - released.length) // 行数只减被释放的两行
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

// ⑩ CAS 退回守卫（codex bot 于 PR #15 指出）：deleteContribution 仅当行仍处首检两态才删——
//    过期巡检结果 / 并发路径不能把已入池（pooled）号误退回（删归属行+删文件）
test('CAS 退回守卫：已入池（pooled）的号不被 deleteContribution 首检态删除', () => {
  const uid = 6010
  const id = 'cas-guard'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId: 'cas-guard-acc', authFileName: 'codex-cas.json', plan: 'plus', linuxdoId: uid, verifyStatus: 'pooled' }),
  )
  // 模拟「过期 reject 结果」路径的删除尝试：行已 pooled → CAS 拒绝、不删
  const deleted = db.deleteContribution(id, ['submitted', 'first_check'])
  assert.equal(deleted, false)
  const still = db.byUser(uid).find((x) => x.id === id)
  assert.ok(still)
  assert.equal(still.verifyStatus, 'pooled') // 归属行完好

  // 仍处首检态的行：CAS 删除成功（正常退回路径）
  db.insertUnique(
    makeContribution({ id: 'cas-guard-2', provider: 'codex', accountId: 'cas-guard-acc-2', authFileName: 'codex-cas2.json', plan: 'plus', linuxdoId: uid, verifyStatus: 'first_check' }),
  )
  assert.equal(db.deleteContribution('cas-guard-2', ['submitted', 'first_check']), true)
  assert.equal(db.byUser(uid).find((x) => x.id === 'cas-guard-2'), undefined)
})

// ⑪ 非配额 retry 不入池（codex xhigh 于 PR #15 指出）：mapInspection 的 retry 还兜「未分类错误/
//    服务端异常/disable」——没证实能登录，不能入池锁唯一键，留首检循环下轮再查
test('codex 非配额 retry（未分类/disable）→ 不入池，留 first_check 下轮复查', async () => {
  const uid = 6011
  const id = 'codex-retry-vague'
  const accountId = 'codex-retry-vague-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  // reason 不命中限额词表（如 disable/未知错误）→ 不入池
  await withInspect([{ accountId, decision: 'retry', plan: 'plus', reason: 'account disabled by action' }], () =>
    collect.processPending(),
  )
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c)
  assert.equal(c.verifyStatus, 'first_check') // 留首检循环，未锁池
  assert.equal(db.balance(uid), 0)
})

// ⑫ 退回顺序：删 auth 文件失败 → 本轮不退回（行保留、唯一键不释放），防孤立文件挡住重交
//    （codex xhigh 于 PR #15 指出：先删行后删文件会留孤立文件，重交同号被授权前快照挡住）
test('退回顺序：deleteAuthFile 失败 → 行保留转 first_check、唯一键不释放，下轮重试', async () => {
  const uid = 6012
  const id = 'codex-rejfail'
  const accountId = 'codex-rejfail-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid }),
  )
  const origDelete = cpa.deleteAuthFile
  cpa.deleteAuthFile = async () => {
    throw new Error('CPA unavailable')
  }
  try {
    await withInspect([{ accountId, decision: 'reject', plan: 'plus', reason: 'unauthorized' }], () =>
      collect.processPending(),
    )
  } finally {
    cpa.deleteAuthFile = origDelete
  }
  const c = db.byUser(uid).find((x) => x.id === id)
  assert.ok(c, '文件删失败时行必须保留（唯一键不释放，防孤立文件挡重交）')
  assert.equal(c.verifyStatus, 'first_check') // 下轮重试退回
})

// ⑬ migration 007：observing 且已记 hard_fail 的行（v6 判死中途崩溃残留）→ stopped 而非 pooled
//    （codex xhigh 于 PR #15 指出：已知死号映成 pooled 会永远挂着无人再查）
test('迁移007：observing+已记 hard_fail → stopped（已知死号不得进池）', () => {
  const d = makeDbAt(6)
  const ins = d.prepare(INSERT)
  // 正常 observing（无 hard_fail）→ pooled
  ins.run('obs-ok', 95, 'acc-obs-ok', 'observing')
  // observing 但 observations 里已有 hard_fail（判死中途崩溃残留）→ stopped
  ins.run('obs-dead', 96, 'acc-obs-dead', 'observing')
  d.prepare(
    'INSERT INTO observations (contribution_id, observed_at, kind, detail, created_at) VALUES (?,?,?,?,?)',
  ).run('obs-dead', 100, 'hard_fail', 'inspect:reject', 100)

  migrate(d)

  const ok = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get('obs-ok') as {
    verify_status: string
  }
  const dead = d.prepare('SELECT verify_status FROM contributions WHERE id=?').get('obs-dead') as {
    verify_status: string
  }
  assert.equal(ok.verify_status, 'pooled') // 健康 observing 正常进池
  assert.equal(dead.verify_status, 'stopped') // 已知死号 → stopped
  d.close()
})
