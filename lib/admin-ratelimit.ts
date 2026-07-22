// ============================================================================
// 管理登录失败限流（§8）：挡暴力猜密码。
//
// 单机单 worker 部署（钉死），模块级内存 Map 即够——按客户端键记连续失败次数，
// 达阈值锁定一段时间。now 参数化（生产传 Date.now()，测试注入固定时钟）；绝不记密码原文。
// 对外只暴露布尔锁定判定，不泄剩余次数/锁定时长（调用方 429 文案也不带计数）。
//
// 限流键取值（resolveClientKey）随「是否信任转发头」分流：x-forwarded-for 默认不可信，
// 否则攻击者每猜一次换个伪造头值使键永新、5 次锁定永凑不满，限流形同虚设。
// ============================================================================

export const MAX_FAILS = 5 // 连续失败达此值即锁定
export const LOCK_MS = 15 * 60_000 // 锁定 15 分钟
export const SWEEP_AT = 1000 // Map 达此规模时按需清扫一遍陈旧条目（免上定时器）

interface Entry {
  fails: number
  lockedUntil: number
  lastFailAt: number // 末次失败时刻，供按需清扫判陈旧
}
const attempts = new Map<string, Entry>()

// 从 x-forwarded-for 解析限流键。信任策略与 lib/request.ts 一致（转发头默认不可信）：
//   trusted=false（默认/生产未开可信反代）——转发头是攻击者可自填的，一律不看，全部直连
//     共享全局桶 'direct'。取舍：攻击期间真管理员的「密码」入口也会被一起锁——可接受，
//     密码猜测防护优先，且 linux.do 白名单管理入口不经此限流、仍可进后台。
//   trusted=true（P6 上可信反代）——反代把真实客户端 IP 追加在末尾＝唯一可信段，取最后一个值；
//     首值是客户端可自带的伪造段，取首值照样能轮换绕过。空/缺头回落 'direct'。
export function resolveClientKey(forwardedFor: string | null, trusted: boolean): string {
  if (!trusted) return 'direct'
  const parts = (forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : 'direct'
}

// 该 key 是否处于锁定期内（锁定期内拒绝尝试）
export function checkLocked(key: string, now: number): boolean {
  const e = attempts.get(key)
  return e != null && e.lockedUntil > now
}

// 记一次登录失败：失败数 +1，达阈值则锁定 LOCK_MS。
//   ⚠️ 锁已过期（曾锁定、lockedUntil 已 ≤ now）时先重置为全新条目再计数——否则解锁后残留
//     fails=MAX_FAILS，下一次失败 ++ 即再达阈值立即又锁 15min，与「锁 15 分钟后恢复」的语义
//     不符（真管理员解锁后手滑一次即被锁死）。
export function recordFail(key: string, now: number): void {
  if (attempts.size >= SWEEP_AT) sweep(now) // Map 过大时先按需清扫（O(n) 仅在大时触发）
  let e = attempts.get(key)
  if (e != null && e.lockedUntil > 0 && e.lockedUntil <= now) e = undefined // 锁已过期 → 从零重计
  const entry = e ?? { fails: 0, lockedUntil: 0, lastFailAt: 0 }
  entry.fails++
  entry.lastFailAt = now
  if (entry.fails >= MAX_FAILS) entry.lockedUntil = now + LOCK_MS
  attempts.set(key, entry)
}

// 登录成功：清除该 key 的失败记录（计数归零）
export function recordSuccess(key: string): void {
  attempts.delete(key)
}

// 按需清扫：删除既不在锁定期、且距末次失败已 ≥ LOCK_MS 的陈旧条目。仅在 Map 达 SWEEP_AT 时
// 触发（免上定时器）；活跃锁定条目（lockedUntil > now）与近期失败条目一律保留。
function sweep(now: number): void {
  for (const [k, e] of attempts) {
    if (e.lockedUntil <= now && now - e.lastFailAt >= LOCK_MS) attempts.delete(k)
  }
}

// 测试辅助：当前 Map 大小（只读，不暴露 Map 本体）
export function attemptsSize(): number {
  return attempts.size
}
