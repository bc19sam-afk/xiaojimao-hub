import { cpa } from './cpa'
import { db } from './db'

// ============================================================================
// 按日用量结算引擎（P2-R2，需求 §3.1/§3.3/§3.4）
//
// 号首检过后进 pooled（在池计量，R1 已装但不发分）。本模块装发分闭环：worker 周期拉 cpamp 每日
// 调用量 → 匹配 pooled 号 → 折算积分（次数 × 单价）→ 按日结算发给号主。一号可持续发分、天天累积。
//
// 幂等铁律（§3.3）：同号同日 worker 重跑 / 重入绝不重复发分。两道闸——
//   ① daily_settlements UNIQUE(contribution_id, date)（recordSettlement DO NOTHING）；
//   ② point_ledger UNIQUE(reason, ref)（awardPoints DO NOTHING，ref='usage:'+cid+':'+date）。
// hasSettled 只是快速跳过闸；正确性靠上面两层 UNIQUE，不靠它。
// ============================================================================

// 毫秒 → 'YYYY-MM-DD' 自然日（服务器本地时区，§3.3「时区随服务器」）。
// 与 lib/cpa.ts 的同名助手各留一份（见那边注释：避免 cpa→settle 反向依赖），两处须一致。
function dayStr(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// running 锁防单进程叠跑（仿 processPending）；跨实例幂等靠 DB 两层 UNIQUE。
let running = false

// now 参数仅为可测（日界判定确定性）：worker 直接调 settleDailyUsage() 用真实时钟。
export async function settleDailyUsage(now: number = Date.now()): Promise<{
  settled: number // 本轮新落库的结算笔数
  awarded: number // 本轮实际发分笔数（points>0 且首次入账）
  skipped?: boolean
}> {
  if (running) return { settled: 0, awarded: 0, skipped: true }
  running = true
  try {
    const today = dayStr(now)
    const usage = await cpa.getDailyUsage()

    // 只结算 pooled 号（§3.2）：按 (provider, account_id) 建索引。非 pooled（stopped/first_check/
    // needs_review/submitted）不在此集 → 有用量也不结算。'\0' 作分隔符（不会出现在 provider/id 里）。
    const byKey = new Map(db.byVerifyStatus(['pooled']).map((c) => [c.provider + '\0' + c.accountId, c]))

    let settled = 0
    let awarded = 0
    for (const u of usage) {
      // 只结算「已过完的自然日」（§3.3 结算前一自然日）：进行中的今天/未来日不结（数据未定型）。
      // 'YYYY-MM-DD' 按字典序即时间序，date < today 等价于 date 早于今天。
      if (u.date >= today) continue
      const c = byKey.get(u.provider + '\0' + u.accountId)
      if (!c) continue // 非 pooled 号 / 未知号 → 不结算
      if (db.hasSettled(c.id, u.date)) continue // 该日已结算 → 跳过（快速闸）

      const points = Math.round(u.count * db.ratePerCall(c.provider, c.plan))

      // 双幂等·先发分后记结算（顺序关键）：若在两次写之间崩溃——
      //   先发后记：重跑见 hasSettled=false → 再发（awardPoints 幂等空转）+ 补记，分不丢；
      //   先记后发：重跑见 hasSettled=true → 跳过 → 那笔分永久丢失（lost pay）。故先发后记。
      // points=0（当日无量 / 单价 0）：awardPoints 内部 delta==0 直接不入账；仍记 settlement 避免反复查。
      if (points > 0 && db.awardPoints(c.linuxdoId, points, 'usage', `usage:${c.id}:${u.date}`)) awarded++
      if (db.recordSettlement({
        contributionId: c.id,
        date: u.date,
        provider: c.provider,
        accountId: c.accountId,
        callCount: u.count,
        points,
      })) settled++
    }
    return { settled, awarded }
  } finally {
    running = false
  }
}
