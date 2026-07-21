import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RedeemItem } from '../lib/db.ts'

// ============================================================================
// P3-R2（LDC 每日限量，在 R1 CDK 发码履约上叠加，非破坏：复用 face_value 预留列 + 加逻辑）。验：
//   面额导入落库、额度内正常发 + 累计、恰好等于额度可发（边界 ≤）、跨额度拦截（不扣分/不占码/整体回滚）、
//   跨日重置（注入 now，不睡等）、同 token 回放不双计额度、非 LDC 的 CDK 不受额度影响、额度取值钳。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指临时目录再**动态 import**；绝不碰真实 data/app.db。
//   ⚠️ 时间敏感：全程注入固定 now（每个测试用独立自然日，见 dayNoon），不依赖真实时钟——CI 负载下不 flaky。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let redeemMod: typeof import('../lib/redeem.ts')
let tmpDir: string
let refSeq = 0

// 每个测试用独立自然日（服务器本地时区），互不污染 ldcIssuedToday 的全局当日求和：
// dayIndex 递增＝日历日递增；ldcIssuedToday 只统计 [该日 0 点, 次日 0 点)，故各测试的码各归各日。
function dayNoon(dayIndex: number): number {
  return new Date(2026, 0, 1 + dayIndex, 12, 0, 0).getTime() // 2026-01-01 + dayIndex 天，正午（本地）
}

function grant(uid: number, amount: number): void {
  db.awardPoints(uid, amount, 'seed', `seed:${uid}:${refSeq++}`)
}

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
    kind: o.kind ?? 'ldc',
    enabled: true,
    sort: 0,
    fulfillment: o.fulfillment ?? 'cdk',
    perUserLimit: o.perUserLimit,
  })
  const it = db.listRedeemItems(false).find((x) => x.name === o.name)
  if (!it) throw new Error('创建兑换项失败: ' + o.name)
  return it
}

// 裸连接读某项 cdk_codes 行（断言面额/占码归属；不经 db 封装，直查表）
function rawCdkRows(
  itemId: number,
): { code: string; status: string; face_value: number | null }[] {
  const raw = new DatabaseSync(process.env.DB_PATH as string)
  raw.exec('PRAGMA busy_timeout = 5000')
  const rows = raw
    .prepare('SELECT code, status, face_value FROM cdk_codes WHERE item_id=? ORDER BY id')
    .all(itemId) as unknown as { code: string; status: string; face_value: number | null }[]
  raw.close()
  return rows
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ldc-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  redeemMod = await import('../lib/redeem.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ⓪ 额度缺省 2000（未配置时）——必须在任何 setLdcQuota 之前断言（同进程共享 app_config，一经 set 即有值）
test('额度缺省：未配置时 getLdcQuota 返回 2000', () => {
  assert.equal(db.getLdcQuota(), 2000)
})

// ① 面额导入落库：LDC 商品的码带批级面额；非 LDC（无面额入参）恒 null；面额取整
test('面额导入：LDC 码落库带面额（一批同面额），非 LDC 恒 null', () => {
  const ldc = createItem({ name: 'ldc-import', cost: 1, kind: 'ldc', fulfillment: 'cdk' })
  const r1 = db.importCdkCodes(ldc.id, ['LA', 'LB'], 100)
  assert.deepEqual(r1, { imported: 2, skipped: 0 })
  // 另一批不同面额（不同面额分批导）
  db.importCdkCodes(ldc.id, ['LC'], 50)
  const rows = rawCdkRows(ldc.id)
  assert.equal(rows.find((r) => r.code === 'LA')!.face_value, 100)
  assert.equal(rows.find((r) => r.code === 'LB')!.face_value, 100)
  assert.equal(rows.find((r) => r.code === 'LC')!.face_value, 50)

  // 非 LDC：importCdkCodes 不传面额 → 恒 null（不受额度约束）
  const plain = createItem({ name: 'plain-import', cost: 1, kind: 'timed_quota', fulfillment: 'cdk' })
  db.importCdkCodes(plain.id, ['PA', 'PB'])
  for (const r of rawCdkRows(plain.id)) assert.equal(r.face_value, null)
})

// ② 额度内正常发 + 累计：quota=100、面额 40，连发两张（40→80）均成功、当日累计正确
test('额度内正常发：连发累计不超额则成功，ldcIssuedToday 反映累计', () => {
  db.setLdcQuota(100)
  const uid = 9001
  const it = createItem({ name: 'ldc-within', cost: 1, kind: 'ldc', fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['B1', 'B2', 'B3'], 40)
  grant(uid, 1000)
  const now = dayNoon(2)
  const r1 = redeemMod.redeem(uid, it.id, { token: 'b1', now })
  const r2 = redeemMod.redeem(uid, it.id, { token: 'b2', now })
  assert.ok(r1.ok && r2.ok, '额度内两发均应成功')
  assert.equal(db.balance(uid), 998) // 各扣 1
  assert.equal(db.ldcIssuedToday(now), 80)
  assert.equal(db.availableCdkCount(it.id), 1)
})

// ③ 边界 ≤：恰好等于额度可发（面额和 == 额度放行）；再发一张跨过额度即拦，且不扣分/不占码/整体回滚
test('边界 ≤：面额和恰等额度可发；跨过即今日已抢完、不扣分、码未占（回滚复原）', () => {
  db.setLdcQuota(100)
  const uid = 9002
  const it = createItem({ name: 'ldc-boundary', cost: 1, kind: 'ldc', fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['C1', 'C2', 'C3'], 50)
  grant(uid, 1000)
  const now = dayNoon(3)
  const r1 = redeemMod.redeem(uid, it.id, { token: 'c1', now }) // 50 ≤ 100
  const r2 = redeemMod.redeem(uid, it.id, { token: 'c2', now }) // 100 ≤ 100（恰好等于，放行）
  assert.ok(r1.ok && r2.ok, '累计恰好等于额度应可发（≤）')
  assert.equal(db.ldcIssuedToday(now), 100)
  assert.equal(db.balance(uid), 998)

  const r3 = redeemMod.redeem(uid, it.id, { token: 'c3', now }) // 150 > 100 → 拦
  assert.ok(!r3.ok && r3.error === '今日已抢完', '跨过额度应今日已抢完')
  assert.equal(db.balance(uid), 998, '被拦不扣分')
  assert.equal(db.availableCdkCount(it.id), 1, '被拦的码未占用、库存复原')
  assert.deepEqual(db.cdkStatsFor(it.id), { available: 1, issued: 2, void: 0 })
  assert.equal(db.ldcIssuedToday(now), 100, '被拦不计入当日已发')
  assert.equal(db.listRedemptions(uid).length, 2, '被拦无兑换记录')
})

// ④ 跨额度拦截（quota=0 极端）：首张即超（面额 100 > 0）→ 今日已抢完、不扣分、不占码、无记录
test('跨额度拦截（quota=0）：首张即拦、事务整体回滚（不扣分/不占码/无记录）', () => {
  db.setLdcQuota(0)
  const uid = 9003
  const it = createItem({ name: 'ldc-zero', cost: 5, kind: 'ldc', fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['Z1', 'Z2'], 100)
  grant(uid, 1000)
  const now = dayNoon(4)
  const r = redeemMod.redeem(uid, it.id, { token: 'z1', now })
  assert.ok(!r.ok && r.error === '今日已抢完')
  assert.equal(db.balance(uid), 1000) // 未扣
  assert.equal(db.listRedemptions(uid).length, 0) // 无记录
  assert.equal(db.availableCdkCount(it.id), 2) // 未占码
  assert.deepEqual(db.cdkStatsFor(it.id), { available: 2, issued: 0, void: 0 })
  assert.equal(db.ldcIssuedToday(now), 0)
})

// ⑤ 跨日重置（注入 now）：昨日发过的面额不计入今日；今日额度按自然日重置
test('跨日重置：昨日已发不占今日额度，跨自然日额度重置', () => {
  db.setLdcQuota(60)
  const uid = 9004
  const it = createItem({ name: 'ldc-crossday', cost: 1, kind: 'ldc', fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['D1', 'D2', 'D3'], 60)
  grant(uid, 1000)
  const day1 = dayNoon(5)
  const day2 = dayNoon(6)
  const r1 = redeemMod.redeem(uid, it.id, { token: 'd1', now: day1 }) // day1: 60 ≤ 60 ok
  const r1b = redeemMod.redeem(uid, it.id, { token: 'd1b', now: day1 }) // day1: 120 > 60 拦
  const r2 = redeemMod.redeem(uid, it.id, { token: 'd2', now: day2 }) // day2: 重置，60 ≤ 60 ok
  assert.ok(r1.ok, 'day1 首张应成功')
  assert.ok(!r1b.ok && r1b.error === '今日已抢完', 'day1 第二张应被当日额度拦')
  assert.ok(r2.ok, 'day2 应因跨日重置而成功')
  assert.equal(db.ldcIssuedToday(day1), 60, 'day1 只发了 1 张')
  assert.equal(db.ldcIssuedToday(day2), 60, 'day2 只发了 1 张（day1 的不计入）')
  assert.equal(db.balance(uid), 998) // 只成功 2 次
})

// ⑥ 同 token 回放不双计额度：重放在①短路 return，不再占码/计额度——即便额度已满也回放成功
test('同 token 回放：不双计额度、不双占码、只扣一次（重放短路于额度判定前）', () => {
  db.setLdcQuota(100)
  const uid = 9005
  const it = createItem({ name: 'ldc-replay', cost: 1, kind: 'ldc', fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['R1', 'R2'], 100)
  grant(uid, 1000)
  const now = dayNoon(7)
  const r1 = redeemMod.redeem(uid, it.id, { token: 'same', now }) // 100 ≤ 100 ok
  const r2 = redeemMod.redeem(uid, it.id, { token: 'same', now }) // 回放：同码、不再计额度
  assert.ok(r1.ok && r2.ok)
  assert.equal(r1.ok && r2.ok && r1.result, r2.result, '回放同一码')
  assert.equal(db.balance(uid), 999, '只扣一次')
  assert.equal(db.listRedemptions(uid).length, 1, '只一条记录')
  assert.equal(db.availableCdkCount(it.id), 1, '只占一个码')
  assert.equal(db.ldcIssuedToday(now), 100, '当日已发仍为 100（未双计到 200）')
})

// ⑦ 非 LDC 的 CDK 不受额度影响：quota=0 也照发（kind≠'ldc'、码无面额，不进额度判定）
test('非 LDC CDK 不受额度约束：quota=0 仍正常发码', () => {
  db.setLdcQuota(0)
  const uid = 9006
  const it = createItem({ name: 'plain-cdk', cost: 1, kind: 'timed_quota', fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['N1', 'N2']) // 无面额
  grant(uid, 1000)
  const now = dayNoon(8)
  const a = redeemMod.redeem(uid, it.id, { token: 'n1', now })
  const b = redeemMod.redeem(uid, it.id, { token: 'n2', now })
  assert.ok(a.ok && b.ok, '非 LDC 应不受 quota=0 影响')
  assert.equal(db.balance(uid), 998)
  assert.equal(db.availableCdkCount(it.id), 0)
})

// ⑧ ldcExhaustedToday（store「今日已抢完」布尔驱动）：额度够发下一张→false、不够→true；
//    无可用码→false（普通「已兑罄」另一路）；非 LDC / 无面额码→false（不受额度约束）
test('ldcExhaustedToday：额度不够发下一张→true，够/无码/无面额→false', () => {
  db.setLdcQuota(100)
  const uid = 9007
  const it = createItem({ name: 'ldc-exhaust', cost: 1, kind: 'ldc', fulfillment: 'cdk' })
  db.importCdkCodes(it.id, ['X1', 'X2'], 60) // 面额 60
  const now = dayNoon(9)
  // 未发码：issuedToday 0 + 下一张 60 = 60 ≤ 100 → 未抢完
  assert.equal(db.ldcExhaustedToday(it.id, now), false)
  grant(uid, 100)
  const r = redeemMod.redeem(uid, it.id, { token: 'x1', now })
  assert.ok(r.ok)
  // 已发 60，下一张 60 → 120 > 100 → 今日已抢完
  assert.equal(db.ldcExhaustedToday(it.id, now), true)
  // 无可用码：普通售罄，非「今日已抢完」（false）
  const nocode = createItem({ name: 'ldc-nocode', cost: 1, kind: 'ldc', fulfillment: 'cdk' })
  assert.equal(db.ldcExhaustedToday(nocode.id, now), false)
  // 无面额码（非 LDC 导入）：不受额度约束，即便 quota=0 也 false
  db.setLdcQuota(0)
  const plain = createItem({ name: 'plain-exhaust', cost: 1, kind: 'timed_quota', fulfillment: 'cdk' })
  db.importCdkCodes(plain.id, ['Y1'])
  assert.equal(db.ldcExhaustedToday(plain.id, now), false)
})

// ⑨ 额度取值钳非负整数：脏值/负数经 set 归零、取整
test('额度取值：setLdcQuota 钳非负整数', () => {
  db.setLdcQuota(-5)
  assert.equal(db.getLdcQuota(), 0, '负数钳为 0')
  db.setLdcQuota(123.9)
  assert.equal(db.getLdcQuota(), 123, '取整')
})
