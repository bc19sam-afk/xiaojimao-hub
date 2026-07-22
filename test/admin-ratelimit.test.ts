import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// 管理登录失败限流（§8）：纯内存、MOCK 无关、不碰 DB/网络。注入固定 now，
// 验「达阈值锁定 → 窗口内继续挡 → LOCK_MS 后解锁 → 成功清零计数」。
// 各用例用独立 key，避免共享模块级 Map 交叉污染。
// ============================================================================

let rl: typeof import('../lib/admin-ratelimit.ts')

before(async () => {
  rl = await import('../lib/admin-ratelimit.ts')
})

test('达 MAX_FAILS 次失败后锁定，锁定窗口内继续被挡', () => {
  const key = 'ip-lock'
  const t0 = 1_000_000
  for (let i = 0; i < rl.MAX_FAILS; i++) {
    assert.equal(rl.checkLocked(key, t0), false) // 未达阈值前不锁
    rl.recordFail(key, t0)
  }
  assert.equal(rl.checkLocked(key, t0), true) // 第 MAX_FAILS 次失败后锁定
  assert.equal(rl.checkLocked(key, t0 + rl.LOCK_MS - 1), true) // 窗口内仍锁
})

test('锁定 LOCK_MS 后解锁', () => {
  const key = 'ip-expire'
  const t0 = 2_000_000
  for (let i = 0; i < rl.MAX_FAILS; i++) rl.recordFail(key, t0)
  assert.equal(rl.checkLocked(key, t0), true)
  assert.equal(rl.checkLocked(key, t0 + rl.LOCK_MS), false) // 到点即解锁（lockedUntil > now 为假）
  assert.equal(rl.checkLocked(key, t0 + rl.LOCK_MS + 1), false)
})

test('recordSuccess 清零计数：清零后需重新累计到阈值才再锁', () => {
  const key = 'ip-success'
  const t0 = 3_000_000
  for (let i = 0; i < rl.MAX_FAILS - 1; i++) rl.recordFail(key, t0) // 差一次到阈值
  assert.equal(rl.checkLocked(key, t0), false)
  rl.recordSuccess(key) // 成功登录 → 清零
  for (let i = 0; i < rl.MAX_FAILS - 1; i++) rl.recordFail(key, t0) // 再累计到差一次（证明从 0 起）
  assert.equal(rl.checkLocked(key, t0), false)
  rl.recordFail(key, t0) // 补齐第 MAX_FAILS 次才锁
  assert.equal(rl.checkLocked(key, t0), true)
})

test('不同 key 相互独立：一个 IP 锁定不影响另一个', () => {
  const a = 'ip-a'
  const b = 'ip-b'
  const t0 = 4_000_000
  for (let i = 0; i < rl.MAX_FAILS; i++) rl.recordFail(a, t0)
  assert.equal(rl.checkLocked(a, t0), true)
  assert.equal(rl.checkLocked(b, t0), false) // b 从未失败 → 不锁
})

// ── 复审 3 条（键随信任策略取值 / 锁过期清计数 / Map 按需清扫）──

test('K1 resolveClientKey：不信任恒 direct、信任取末值、空头回落 direct', () => {
  // 不信任转发头：给了伪造头也无视，恒 'direct'
  assert.equal(rl.resolveClientKey('1.2.3.4', false), 'direct')
  assert.equal(rl.resolveClientKey('fake, evil', false), 'direct')
  assert.equal(rl.resolveClientKey(null, false), 'direct')
  // 信任：取最后一个值（反代追加的真实 IP），首值是客户端可伪造段
  assert.equal(rl.resolveClientKey('fake, 1.2.3.4', true), '1.2.3.4')
  assert.equal(rl.resolveClientKey('  a , b , 9.9.9.9 ', true), '9.9.9.9')
  assert.equal(rl.resolveClientKey('1.1.1.1', true), '1.1.1.1')
  // 信任但空/缺头 → 回落 'direct'
  assert.equal(rl.resolveClientKey(null, true), 'direct')
  assert.equal(rl.resolveClientKey('', true), 'direct')
  assert.equal(rl.resolveClientKey('  ,  ', true), 'direct')
})

test('K2 绕过回归：不信任下伪造头轮换仍落同一 direct 桶 → MAX_FAILS 次即锁', () => {
  const t0 = 20_000_000
  for (let i = 0; i < rl.MAX_FAILS; i++) {
    const key = rl.resolveClientKey(`10.0.0.${i}`, false) // 每次换个伪造头
    assert.equal(key, 'direct') // 恒落全局桶
    rl.recordFail(key, t0)
  }
  // 第 MAX_FAILS+1 次即便再换头，仍被同一 direct 桶挡下
  assert.equal(rl.checkLocked(rl.resolveClientKey('10.0.0.99', false), t0), true)
})

test('K3 解锁后计数重置：锁到期后单次失败不立即再锁', () => {
  const key = 'ip-k3'
  const t0 = 10_000_000
  for (let i = 0; i < rl.MAX_FAILS; i++) rl.recordFail(key, t0) // 锁定
  assert.equal(rl.checkLocked(key, t0), true)
  const after = t0 + rl.LOCK_MS // 锁到期
  assert.equal(rl.checkLocked(key, after), false)
  rl.recordFail(key, after) // 解锁后第一次失败——应重置计数，不立即再锁
  assert.equal(rl.checkLocked(key, after), false, '解锁后单次失败不应立即再锁')
  for (let i = 0; i < rl.MAX_FAILS - 1; i++) rl.recordFail(key, after) // 需再凑满才锁
  assert.equal(rl.checkLocked(key, after), true)
})

test('K4 按需清扫：Map 达阈值时删陈旧条目、活跃锁定条目保留', () => {
  const tOld = 500_000_000
  const tNow = tOld + rl.LOCK_MS + 1 // 此刻陈旧 key 均已过期且距末次失败超 LOCK_MS
  // 造 SWEEP_AT 个陈旧 key（各于 tOld 失败一次、未锁定）
  for (let i = 0; i < rl.SWEEP_AT; i++) rl.recordFail(`stale-${i}`, tOld)
  // 1 个活跃锁定 key：于 tNow 连续失败至锁定（首次失败时 size≥SWEEP_AT → 触发清扫）
  for (let i = 0; i < rl.MAX_FAILS; i++) rl.recordFail('klock', tNow)
  assert.equal(rl.checkLocked('klock', tNow), true, '活跃锁定条目应保留')
  assert.equal(rl.checkLocked('stale-0', tNow), false, '陈旧条目应被清扫')
  assert.ok(rl.attemptsSize() < rl.SWEEP_AT, 'Map 应收缩到远小于清扫阈值')
})
