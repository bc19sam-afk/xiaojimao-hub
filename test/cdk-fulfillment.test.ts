import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { RedeemItem } from '../lib/db.ts'

// ============================================================================
// P3-R1（CDK 履约闭环，非破坏：加表 + 加逻辑）。两部分：
//   Part A —— migration 011 结构：v10 库跑迁移后 cdk_codes 表在、redeem_items 加 per_user_limit/
//             fulfillment 两列、face_value 预留列在、UNIQUE(item_id, code) 生效、版本到最新。内存库直驱。
//   Part B —— 导入去重 + 兑换单事务（走 lib/redeem.ts redeem + lib/db.ts，MOCK、单例连接）：
//             导入去重、happy 发码、幂等回放（同 token / 短窗兜底）、独立 token 发两码、售罄、限购、
//             积分不足（回滚复原库存＝bug① 原子性）、占位类保留、找回限本人（§8）、parseCdkCodes。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指向临时目录再**动态 import**；绝不碰真实 data/app.db。
// ============================================================================

// ---------------------------- Part A：migration 011（内存库）----------------------------

function makeDbAt(target: number): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const m of migrations.filter((m) => m.version <= target).sort((a, b) => a.version - b.version)) {
    m.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(target)
  return d
}
function tableNames(d: DatabaseSync): Set<string> {
  const rows = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}
function columns(d: DatabaseSync, table: string): Set<string> {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

test('迁移011：建 cdk_codes、redeem_items 加 per_user_limit/fulfillment、face_value 预留、UNIQUE(item_id,code) 生效', () => {
  assert.ok(migrations.some((m) => m.version === 11), '应存在 migration 011')
  const d = makeDbAt(10) // stamped v10 → migrate 只跑 011
  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)
  const names = tableNames(d)
  assert.ok(names.has('cdk_codes'), '缺表 cdk_codes')

  const cdkCols = columns(d, 'cdk_codes')
  for (const c of ['item_id', 'code', 'status', 'face_value', 'issued_to', 'redemption_id', 'issued_at', 'created_at']) {
    assert.ok(cdkCols.has(c), `cdk_codes 缺列 ${c}`)
  }
  const itemCols = columns(d, 'redeem_items')
  assert.ok(itemCols.has('per_user_limit'), 'redeem_items 缺列 per_user_limit')
  assert.ok(itemCols.has('fulfillment'), 'redeem_items 缺列 fulfillment')

  // UNIQUE(item_id, code)：同项同码二次插入必冲突（导入去重的地基）；不同项同码不冲突
  const ins = (itemId: number, code: string) =>
    d.prepare("INSERT INTO cdk_codes (item_id, code, status, created_at) VALUES (?,?,'available',1)").run(itemId, code)
  ins(1, 'DUP')
  assert.throws(() => ins(1, 'DUP'), /UNIQUE|constraint/i, '同 (item_id, code) 应违反唯一约束')
  ins(2, 'DUP') // 不同项同码可插
  const n = d.prepare("SELECT COUNT(*) AS n FROM cdk_codes WHERE code='DUP'").get() as { n: number }
  assert.equal(n.n, 2)
  d.close()
})

test('迁移011：既有 redeem_items 行获默认 fulfillment=placeholder / per_user_limit=0（ADD COLUMN 非破坏）', () => {
  const d = makeDbAt(10)
  // 迁移前（v10 结构）先插一个兑换项（无新列）
  d.prepare("INSERT INTO redeem_items (name, description, cost, kind, sort) VALUES ('老项','',10,'vip',0)").run()
  migrate(d) // 跑 011 加列
  const row = d.prepare("SELECT fulfillment, per_user_limit FROM redeem_items WHERE name='老项'").get() as {
    fulfillment: string
    per_user_limit: number
  }
  assert.equal(row.fulfillment, 'placeholder')
  assert.equal(row.per_user_limit, 0)
  d.close()
})

// ---------------------------- Part B：导入 + 兑换（单例连接 / MOCK）----------------------------

let db: typeof import('../lib/db.ts').db
let redeemMod: typeof import('../lib/redeem.ts')
let tmpDir: string
let refSeq = 0

// 给用户发种子积分（awardPoints 幂等键须唯一，用自增序保证确定）
function grant(uid: number, amount: number): void {
  db.awardPoints(uid, amount, 'seed', `seed:${uid}:${refSeq++}`)
}

// 建兑换项并回读（upsert 不返回 id，按唯一名字回查）
function createItem(o: {
  name: string
  cost: number
  kind?: string
  fulfillment?: string
  perUserLimit?: number
}): RedeemItem {
  db.upsertRedeemItem({
    name: o.name,
    description: '',
    cost: o.cost,
    kind: o.kind ?? 'timed_quota',
    enabled: true,
    sort: 0,
    fulfillment: o.fulfillment,
    perUserLimit: o.perUserLimit,
  })
  const it = db.listRedeemItems(false).find((x) => x.name === o.name)
  if (!it) throw new Error('创建兑换项失败: ' + o.name)
  return it
}

// 裸连接读某项 cdk_codes 行（供断言发放归属回填；不经 db 封装，直查表）
function rawCdkRows(
  itemId: number,
): { code: string; status: string; issued_to: number | null; redemption_id: string | null; issued_at: number | null }[] {
  const raw = new DatabaseSync(process.env.DB_PATH as string)
  raw.exec('PRAGMA busy_timeout = 5000')
  const rows = raw
    .prepare('SELECT code, status, issued_to, redemption_id, issued_at FROM cdk_codes WHERE item_id=? ORDER BY id')
    .all(itemId) as unknown as {
    code: string
    status: string
    issued_to: number | null
    redemption_id: string | null
    issued_at: number | null
  }[]
  raw.close()
  return rows
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-cdk-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  redeemMod = await import('../lib/redeem.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ① 导入去重：批内重复 + 跨批已存都跳过；返回 {imported, skipped}；availableCdkCount 反映净入库
test('导入去重：批内 + 跨批已存跳过，计数与库存正确', () => {
  const it = createItem({ name: 'cdk-import', cost: 1, fulfillment: 'cdk' })
  const r1 = db.importCdkCodes(it.id, ['A', 'B', 'C'])
  assert.deepEqual(r1, { imported: 3, skipped: 0 })
  assert.equal(db.availableCdkCount(it.id), 3)
  // B/C 已存（skip 2）、D 新（import 1）、第二个 D 批内重复（skip 1）
  const r2 = db.importCdkCodes(it.id, ['B', 'C', 'D', 'D'])
  assert.deepEqual(r2, { imported: 1, skipped: 3 })
  assert.equal(db.availableCdkCount(it.id), 4)
  assert.deepEqual(db.cdkStatsFor(it.id), { available: 4, issued: 0, void: 0 })
})

// ② 兑换 happy（cdk）：发一个码、扣分、写记录、回填码归属、库存减一
test('兑换 happy（cdk）：返回码、扣分、写 fulfilled 记录、码回填 issued_to/redemption_id/issued_at', () => {
  const uid = 8001
  const it = createItem({ name: 'cdk-happy', cost: 10, fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['CODE-1', 'CODE-2'])
  grant(uid, 50)
  const res = redeemMod.redeem(uid, it.id, { token: 't-happy' })
  assert.ok(res.ok, '兑换应成功')
  assert.ok(res.ok && ['CODE-1', 'CODE-2'].includes(res.result), '结果应是导入的某个码')
  assert.equal(res.ok && res.balance, 40)
  assert.equal(db.balance(uid), 40)
  const reds = db.listRedemptions(uid)
  assert.equal(reds.length, 1)
  assert.equal(reds[0].status, 'fulfilled')
  assert.equal(reds[0].result, res.ok ? res.result : '')
  assert.equal(db.availableCdkCount(it.id), 1)
  assert.deepEqual(db.cdkStatsFor(it.id), { available: 1, issued: 1, void: 0 })
  // 发放归属回填：被占的那行 status=issued 且三列非空、issued_to=uid
  const issued = rawCdkRows(it.id).find((r) => r.status === 'issued')
  assert.ok(issued, '应有一行 issued')
  assert.equal(issued.issued_to, uid)
  assert.ok(issued.redemption_id, 'redemption_id 应回填')
  assert.ok(issued.issued_at, 'issued_at 应回填')
  assert.equal(issued.code, res.ok ? res.result : '')
})

// ③ 幂等（同 token）：重复兑换 → 回放同一码，只扣一次分、只占一个码、只一条记录
test('幂等（同 token）：重复兑换回放同码、只扣一次、只占一码', () => {
  const uid = 8002
  const it = createItem({ name: 'cdk-idem', cost: 10, fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['I-1', 'I-2'])
  grant(uid, 50)
  const r1 = redeemMod.redeem(uid, it.id, { token: 'same-token' })
  const r2 = redeemMod.redeem(uid, it.id, { token: 'same-token' })
  assert.ok(r1.ok && r2.ok)
  assert.equal(r1.ok && r2.ok && r1.result, r2.result) // 同一码
  assert.equal(db.balance(uid), 40) // 只扣一次
  assert.equal(db.listRedemptions(uid).length, 1) // 只一条记录
  assert.equal(db.availableCdkCount(it.id), 1) // 只占一个码
})

// ④ 独立 token → 两次不同码、扣两次
test('独立 token：两次兑换发两个不同码、各扣一次', () => {
  const uid = 8003
  const it = createItem({ name: 'cdk-two', cost: 10, fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['T-1', 'T-2'])
  grant(uid, 50)
  const a = redeemMod.redeem(uid, it.id, { token: 'tok-a' })
  const b = redeemMod.redeem(uid, it.id, { token: 'tok-b' })
  assert.ok(a.ok && b.ok)
  assert.notEqual(a.ok && a.result, b.ok && b.result) // 不同码
  assert.equal(db.balance(uid), 30) // 扣两次
  assert.equal(db.listRedemptions(uid).length, 2)
  assert.equal(db.availableCdkCount(it.id), 0)
  assert.deepEqual(db.cdkStatsFor(it.id), { available: 0, issued: 2, void: 0 })
})

// ⑤ 售罄：无 available 码 → 「已兑罄」、不扣分、无记录
test('售罄：库存耗尽后再兑 → 已兑罄、不扣分、无记录', () => {
  const uidA = 8004
  const uidB = 8005
  const it = createItem({ name: 'cdk-soldout', cost: 5, fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['ONLY-1']) // 只 1 个
  grant(uidA, 50)
  grant(uidB, 50)
  const a = redeemMod.redeem(uidA, it.id, { token: 'a' })
  assert.ok(a.ok)
  const b = redeemMod.redeem(uidB, it.id, { token: 'b' })
  assert.ok(!b.ok && b.error === '已兑罄', '第二个应已兑罄')
  assert.equal(db.balance(uidB), 50) // 未扣
  assert.equal(db.listRedemptions(uidB).length, 0) // 无记录
  assert.equal(db.availableCdkCount(it.id), 0)
})

// ⑥ 限购：per_user_limit=1，本人第二次（新 token）→「超过限购」、不扣分、库存不动
test('限购：达上限再兑 → 超过限购、不扣分、库存不动', () => {
  const uid = 8006
  const it = createItem({ name: 'cdk-limit', cost: 5, fulfillment: 'cdk', perUserLimit: 1 })
  db.importCdkCodes(it.id, ['L-1', 'L-2', 'L-3'])
  grant(uid, 50)
  const a = redeemMod.redeem(uid, it.id, { token: 'la' })
  assert.ok(a.ok)
  const b = redeemMod.redeem(uid, it.id, { token: 'lb' }) // 新 token＝新手势，非回放
  assert.ok(!b.ok && b.error === '超过限购', '第二次应超过限购')
  assert.equal(db.balance(uid), 45) // 只扣一次
  assert.equal(db.listRedemptions(uid).length, 1)
  assert.equal(db.availableCdkCount(it.id), 2) // 只占了 1 个
})

// ⑦ 积分不足：不扣分且**回滚复原已占库存**（bug① 原子性：扣分失败整体回滚，占码撤销）
test('积分不足：不扣分、无记录、且占码被回滚复原（原子性）', () => {
  const uid = 8007
  const it = createItem({ name: 'cdk-poor', cost: 100, fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['P-1', 'P-2'])
  grant(uid, 10) // < cost
  const r = redeemMod.redeem(uid, it.id, { token: 'poor' })
  assert.ok(!r.ok && r.error === '积分不足')
  assert.equal(db.balance(uid), 10) // 未扣
  assert.equal(db.listRedemptions(uid).length, 0) // 无记录
  assert.equal(db.availableCdkCount(it.id), 2) // 占码已回滚，库存复原
  assert.deepEqual(db.cdkStatsFor(it.id), { available: 2, issued: 0, void: 0 })
})

// ⑧ 短窗兜底（无 token）：同一 (用户,项) 同窗口重复 → 回放；跨窗口 → 新码新扣分
test('短窗兜底（无 token）：同窗回放、跨窗新发', () => {
  const uid = 8008
  const it = createItem({ name: 'cdk-window', cost: 5, fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['W-1', 'W-2'])
  grant(uid, 50)
  const now = 1_000_000_000_000
  const a1 = redeemMod.redeem(uid, it.id, { now })
  const a2 = redeemMod.redeem(uid, it.id, { now: now + 5_000 }) // 同 10s 桶 → 回放
  assert.ok(a1.ok && a2.ok)
  assert.equal(a1.ok && a2.ok && a1.result, a2.result)
  assert.equal(db.balance(uid), 45) // 只扣一次
  const b = redeemMod.redeem(uid, it.id, { now: now + 20_000 }) // 跨桶 → 新发
  assert.ok(b.ok)
  assert.notEqual(a1.ok && a1.result, b.ok && b.result)
  assert.equal(db.balance(uid), 40) // 又扣一次
})

// ⑨ 占位类保留：非发码项走占位（invite_code→XJM- 码 / 其它→中文占位串），不碰 CDK 库存
test('占位类保留：invite_code 发 XJM- 占位码、vip 发中文占位串，不碰 CDK', () => {
  const uid = 8009
  const inv = createItem({ name: 'ph-invite', cost: 10, kind: 'invite_code' }) // fulfillment 默认 placeholder
  const vip = createItem({ name: 'ph-vip', cost: 10, kind: 'vip' })
  grant(uid, 50)
  const a = redeemMod.redeem(uid, inv.id, { token: 'pa' })
  assert.ok(a.ok && a.result.startsWith('XJM-INV-'), '邀请码占位应发 XJM- 码')
  const b = redeemMod.redeem(uid, vip.id, { token: 'pb' })
  assert.ok(b.ok && b.result === '已发放（占位，待接小鸡毛履约）')
  assert.equal(db.balance(uid), 30) // 各扣一次
  assert.equal(db.availableCdkCount(inv.id), 0) // 占位项无 CDK 交互
  assert.deepEqual(db.cdkStatsFor(inv.id), { available: 0, issued: 0, void: 0 })
})

// ⑩ 找回限本人（§8）：他人接口看不到我的码；本人兑换记录可重看
test('找回限本人：listRedemptions 只含本人的码，他人查不到', () => {
  const me = 8010
  const other = 8011
  const it = createItem({ name: 'cdk-privacy', cost: 5, fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['SECRET-1'])
  grant(me, 50)
  const r = redeemMod.redeem(me, it.id, { token: 'mine' })
  assert.ok(r.ok)
  const mine = db.listRedemptions(me)
  assert.ok(mine.some((x) => x.result === (r.ok ? r.result : '')), '本人应能重看自己的码')
  const theirs = db.listRedemptions(other)
  assert.equal(theirs.length, 0, '他人接口不应含我的码')
  assert.ok(!theirs.some((x) => x.result === (r.ok ? r.result : '')))
})

// ⑪ parseCdkCodes：换行/逗号/空白分隔 + trim + 去空 + 去重
test('parseCdkCodes：分隔/trim/去空/去重', () => {
  assert.deepEqual(redeemMod.parseCdkCodes('A\nB, C\n\n  D  '), ['A', 'B', 'C', 'D'])
  assert.deepEqual(redeemMod.parseCdkCodes(['X', 'X', 'Y', '  ', 'Z']), ['X', 'Y', 'Z'])
  assert.deepEqual(redeemMod.parseCdkCodes(''), [])
})
