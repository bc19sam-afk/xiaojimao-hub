import { cpa, type DailyUsage } from './cpa'
import { db, shortAccountLabel } from './db'

// ============================================================================
// 按日用量结算引擎（P2-R2，需求 §3.1/§3.3/§3.4）
//
// 号首检过后进 pooled（在池计量，R1 已装但不发分）。本模块装发分闭环：worker 周期拉 cpamp 每日
// 调用量 → 匹配 pooled 号 → 折算积分（次数 × 单价）→ 按日结算发给号主。一号可持续发分、天天累积。
//
// 幂等铁律（§3.3）：daily_settlements 唯一行保存累计水位，higher 快照只追加正 delta ledger；
// BEGIN IMMEDIATE + 稳定 ref 负责跨进程串行和重试幂等。
// ============================================================================

// 毫秒 → 'YYYY-MM-DD' 自然日（服务器本地时区，§3.3「时区随服务器」）。
// 与 lib/cpa.ts 的同名助手各留一份（见那边注释：避免 cpa→settle 反向依赖），两处须一致。
function dayStr(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const SETTLEMENT_PROVIDERS = new Set(['codex', 'claude', 'grok'])

function isValidDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

// Validate the complete internal snapshot before any settlement write. This also protects tests or a
// future CpaClient implementation that bypasses the real-client payload parser.
function assertValidUsageSnapshot(value: unknown): asserts value is DailyUsage[] {
  if (!Array.isArray(value)) throw new Error('invalid daily usage snapshot')
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('invalid daily usage snapshot')
    const usage = item as Partial<DailyUsage>
    if (typeof usage.accountId !== 'string' || usage.accountId.trim() === '' ||
        typeof usage.provider !== 'string' || !SETTLEMENT_PROVIDERS.has(usage.provider) ||
        typeof usage.date !== 'string' || !isValidDay(usage.date) ||
        !Number.isSafeInteger(usage.count) || (usage.count as number) < 0) {
      throw new Error('invalid daily usage snapshot')
    }
  }
}

// 本进程今天是否已跑过结算（按日驱动，codex xhigh 于 PR #16 指出：/v0/management/usage 是 ~19MB 全量
// 事件流，8s tick 每轮都拉＝~205GB/天。结算一天一次就够）。进程重启后重跑一次无害——累计水位
// reconciliation 会把 same 变成 no-op、把 higher 只补新增 count，只多一次拉取。
let lastRunDay = ''

// running 锁防单进程叠跑（仿 processPending）；跨实例幂等靠 BEGIN IMMEDIATE + 单调水位 + 稳定 ledger ref。
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
  // 🔴 本轮被 **running 锁** 挡住（P6-R2 复审三轮第 3 条）：**只是给调用方的健康信号**，
  //    结算语义分毫未动。skipped 有三个来源，只有这一个代表「上一轮还卡在某个 await 没回来」：
  //      ① running 锁       ＝真的卡住了     → lockHeld=true，worker 据此掐心跳
  //      ② 日切 grace 窗内   ＝正常节流       → 只有 skipped，不掐
  //      ③ 今天已结算过     ＝正常节流       → 只有 skipped，不掐
  //    ⚠️ 绝不能把 ②③ 也并进健康判据：实测 8s tick、一天 10800 轮下 settleDailyUsage 因
  //       grace 窗 + 日闸 skip 掉 99.99% 的轮次，并进去＝心跳一天最多 1 次，而外部 Period
  //       建议 5 分钟 → 恒定误报。故必须用独立标志位区分，不能复用 skipped。
  lockHeld?: boolean
}> {
  if (running) return { settled: 0, awarded: 0, skipped: true, lockHeld: true }
  // 日切延迟（结算时刻，§3.3）：过了午夜再等这么久才结「昨天」，减少 cpamp 侧迟到落账；即使仍有迟到，
  // 后续 higher 快照也只补新增 count。默认 10 分钟＝「每日 00:10 结算前一自然日」，
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
    assertValidUsageSnapshot(usage)

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
      const r = db.reconcileUsageSettlement({
        contributionId: c.id,
        date: u.date,
        provider: c.provider,
        accountId: c.accountId,
        plan: c.plan,
        callCount: u.count,
        linuxdoId: c.linuxdoId,
      })
      if (r.status === 'invalid') {
        console.error(
          `[settle] 跳过非法折算：provider=${c.provider} account=${shortAccountLabel(c.provider, c.accountId)} date=${u.date} rate=${r.rate}`,
        )
        continue
      }
      if (r.status === 'regressed') {
        console.warn(
          `[settle] usage snapshot regressed：provider=${c.provider} account=${shortAccountLabel(c.provider, c.accountId)} date=${u.date} observed=${u.count} watermark=${r.previousCallCount}`,
        )
      }
      if (r.settled) settled++
      if (r.awarded) awarded++
    }
    lastRunDay = today // 成功跑完才记（中途抛错不记，下轮重试）
    return { settled, awarded }
  } finally {
    running = false
  }
}
