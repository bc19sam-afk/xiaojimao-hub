// ============================================================================
// 管理登录失败限流（§8）：挡暴力猜密码。
//
// 单机单 worker 部署（钉死），模块级内存 Map 即够——按客户端 IP 记连续失败次数，
// 达阈值锁定一段时间。now 参数化（生产传 Date.now()，测试注入固定时钟）；绝不记密码原文。
// 对外只暴露布尔锁定判定，不泄剩余次数/锁定时长（调用方 429 文案也不带计数）。
// ============================================================================

export const MAX_FAILS = 5 // 连续失败达此值即锁定
export const LOCK_MS = 15 * 60_000 // 锁定 15 分钟

interface Entry {
  fails: number
  lockedUntil: number
}
const attempts = new Map<string, Entry>()

// 该 key 是否处于锁定期内（锁定期内拒绝尝试）
export function checkLocked(key: string, now: number): boolean {
  const e = attempts.get(key)
  return e != null && e.lockedUntil > now
}

// 记一次登录失败：失败数 +1，达阈值则锁定 LOCK_MS
export function recordFail(key: string, now: number): void {
  const e = attempts.get(key) ?? { fails: 0, lockedUntil: 0 }
  e.fails++
  if (e.fails >= MAX_FAILS) e.lockedUntil = now + LOCK_MS
  attempts.set(key, e)
}

// 登录成功：清除该 key 的失败记录（计数归零）
export function recordSuccess(key: string): void {
  attempts.delete(key)
}
