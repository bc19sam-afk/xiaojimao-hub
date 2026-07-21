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
