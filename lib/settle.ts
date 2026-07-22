import { cpa } from './cpa'
import { db, shortAccountLabel } from './db'

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

// 本进程今天是否已跑过结算（按日驱动，codex xhigh 于 PR #16 指出：/v0/management/usage 是 ~19MB 全量
// 事件流，8s tick 每轮都拉＝~205GB/天。结算一天一次就够）。进程重启后重跑一次无害——hasSettled/两层
// UNIQUE 兜幂等，只多一次拉取。
let lastRunDay = ''

// running 锁防单进程叠跑（仿 processPending）；跨实例幂等靠 DB 两层 UNIQUE。
let running = false

// now 参数仅为可测（日界判定确定性）：worker 直接调 settleDailyUsage() 用真实时钟。
// force 供测试/手动触发跳过「一天一次」节流（不跳过日切延迟与幂等闸）。
export async function settleDailyUsage(
  now: number = Date.now(),
  opts: { force?: boolean } = {},
): Promise<{
  settled: number // 本轮新落库的结算笔数
  awarded: number // 本轮实际发分笔数（points>0 且首次入账）
  skipped?: boolean
}> {
  if (running) return { settled: 0, awarded: 0, skipped: true }
  // 日切延迟（结算时刻，§3.3）：过了午夜再等这么久才结「昨天」，吸收 cpamp 侧迟到落账——太早结、hasSettled
  // 闸会把迟到量永久排除（codex xhigh 于 PR #16 指出）。默认 10 分钟＝「每日 00:10 结算前一自然日」，
  // 后台可配（db.getSettleGraceMs，缺省仍 10min）；时区随服务器不可配。
  const graceMs = db.getSettleGraceMs()
  const sinceMidnight = now - new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
  if (sinceMidnight < graceMs) return { settled: 0, awarded: 0, skipped: true }
  const today = dayStr(now)
  // 按日驱动：本进程今天已跑过 → 跳过（不再全量拉 usage）。force 供测试/手动。
  if (!opts.force && lastRunDay === today) return { settled: 0, awarded: 0, skipped: true }
  running = true
  try {
    const usage = await cpa.getDailyUsage()

    // 结算资格＝**入过池**的号（pooled_at 非空，见 db.eligibleForSettlement / migration 010）——不看当前
    // verify_status：含 pooled（在池计量）+ stopped/needs_review（存活巡检转态后补结历史欠薪）。首检
    // reauth 直接转 needs_review 的号**从没入池**（pooled_at null）不在此集，绝不错发（codex xhigh 于
    // PR #18 指出：无脑按 needs_review 态判会给从没入池的号发分）。'\0' 作分隔符（不出现在 provider/id）。
    const byKey = new Map(
      db.eligibleForSettlement().map((c) => [c.provider + '\0' + c.accountId, c]),
    )

    let settled = 0
    let awarded = 0
    for (const u of usage) {
      // 只结算「已过完的自然日」（§3.3 结算前一自然日）：进行中的今天/未来日不结（数据未定型）。
      // 'YYYY-MM-DD' 按字典序即时间序，date < today 等价于 date 早于今天。
      if (u.date >= today) continue
      const c = byKey.get(u.provider + '\0' + u.accountId)
      if (!c) continue // 无资格号（从没入池）/ 未知号 → 不结算
      // 结算下界＝**入池次日**起（入池当天也不结）：cpamp getDailyUsage 按自然日给量，号入池当天那笔
      // u.date 混了「入池前号主自用」+「入池后贡献」两段、无法按小时拆分（codex 于 PR #18 复审指出下界
      // 只到日粒度会把入池前自用误算发分）→ 保守整日不结、次日起才发。'<=' 即把入池当日一并挡掉。
      if (c.pooledAt != null && u.date <= dayStr(c.pooledAt)) continue
      if (db.hasSettled(c.id, u.date)) continue // 该日已结算 → 跳过（快速闸）

      const rate = db.ratePerCall(c.provider, c.plan)
      const points = Math.round(u.count * rate)
      // 结算防御闸（P4-R2 codex 复审 P2）：单价被写脏（历史遗留 Infinity/NaN，或绕过路由上界直写 db）→ points
      // 非法（溢出 Infinity / NaN / 负）。一律不结不发、跳过——留待管理员修好单价后下轮重结自愈（该日未落
      // settlement，hasSettled 不吞）。⚠️ 绝不记 points=0 的 settlement 凑数：那会让 hasSettled 把该日欠薪永久吞掉。
      if (!Number.isSafeInteger(points) || points < 0) {
        console.error(
          `[settle] 跳过非法折算 points=${points}：provider=${c.provider} account=${shortAccountLabel(c.provider, c.accountId)} date=${u.date} rate=${rate}`,
        )
        continue
      }
      // 发分 + 记结算同一事务（settleAndAward，BEGIN IMMEDIATE）：夹缝崩溃不再产生「ledger 已入账、
      // settlement 未记」的分叉；两层 UNIQUE 仍各自幂等兜底。points=0 不入账、仍记 settlement 免反复查。
      const r = db.settleAndAward({
        contributionId: c.id,
        date: u.date,
        provider: c.provider,
        accountId: c.accountId,
        callCount: u.count,
        points,
        linuxdoId: c.linuxdoId,
      })
      if (r.settled) settled++
      if (r.awarded) awarded++
    }
    lastRunDay = today // 成功跑完才记（中途抛错不记，下轮重试）
    return { settled, awarded }
  } finally {
    running = false
  }
}
