import { randomBytes } from 'crypto'
import { cpa, type IngestResult, type ProbeResult, type ProviderId, type StartResult } from './cpa'
import { db, type Contribution, type ObservationKind } from './db'
import { env } from './env'
import type { SessionUser } from './session'

type CollectResult =
  | { ok: true; contribution: Contribution }
  | { ok: false; error: string }

// 把一个已落号的结果记为贡献：pending，等巡检。
function recordIngest(
  user: SessionUser,
  provider: ProviderId,
  result: IngestResult,
  method: 'oauth' | 'rt',
): CollectResult {
  // 认不出身份：findNew 没找到本 provider 的新号（accountId 空），或三家稳定字段全读不到的
  // 残缺号——这不是「重复」，用重复文案会误导用户。诚实提示重试即可（认不出身份的号进
  // needs_review + 人工录入 canonical ID 留待 P2；三家都有稳定字段后此处只剩残缺/异常号）。
  if (!result.accountId) {
    return { ok: false, error: '未能确认到新授权的账号，请确认已完成授权后重试' }
  }
  // 真重复：拿到了 accountId，但该 (provider, accountId) 已被贡献过 / 池中已有。
  if (result.duplicate) {
    return { ok: false, error: '这个号交过了，不能再交' }
  }
  const now = Date.now()
  const contribution: Contribution = {
    id: randomBytes(8).toString('hex'),
    linuxdoId: user.id,
    username: user.username,
    accountId: result.accountId,
    email: result.email,
    provider,
    plan: result.plan,
    method,
    authFileName: result.authFileName,
    verifyStatus: 'submitted',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
  }
  const { duplicate } = db.insertUnique(contribution)
  if (duplicate) return { ok: false, error: '这个号交过了，不能再交' }
  return { ok: true, contribution }
}

// 隔离新号（禁用），未验证不进生产调度
async function isolate(authFileName: string): Promise<void> {
  if (!authFileName) return
  try {
    await cpa.setDisabled(authFileName, true)
  } catch {
    /* 隔离失败不阻断；巡检阶段仍会再判 */
  }
}

// 从回调 URL 解析 OAuth state（快照键）。解析不出返回 ''——真实模式下无 state＝无法定位授权前
// 快照，走 fail-closed 拒绝（见 finishOAuth）；「回调链接格式不对」的用户提示仍由 cpa.finishOAuth 负责。
function parseState(redirectUrl: string): string {
  try {
    return new URL(redirectUrl).searchParams.get('state') ?? ''
  } catch {
    return ''
  }
}

// 真实模式下快照缺失的 fail-closed 拒绝语（codex xhigh 于 PR #10 指出：静默降级为空 before
// ＝完全退化回抢注号池既有号的旧行为——响应丢失后的重试、快照过期、部署前发起的授权都会踩中）。
// mock 模式不设此门：mock 的 finishOAuth/checkOAuth 走 mockCreate 不调 findNew，空 before 无害，
// 且演示/测试常直接调 finishOAuth 不经 startOAuth。
const SNAPSHOT_MISSING_ERROR = '授权会话已过期或已完成，请重新点击「发起授权」后再试'

// —— 发起授权（provider 决定流程：redirect / device）——
// P1b-4：授权前给 auth-files 拍文件名快照，按 state 持久化跨请求。finishOAuth/checkOAuth 读它作
// findNew 的 before，挡号池既有号（见 cpa.ts findNew 注释③）。此刻（授权前）池里还没本次将落的新号、
// 且快照固定不变——retry 同 state 读同一快照不孤立、device 同样能读。state 为空则跳过（降级空 before）。
export async function startOAuth(provider: ProviderId): Promise<StartResult> {
  const result = await cpa.startOAuth(provider)
  if (result.state) {
    const names = (await cpa.listAuthFiles()).map((f) => f.name).filter(Boolean)
    db.setOAuthSnapshot(result.state, names)
    db.cleanupOAuthSnapshots(3600_000) // 顺带清理 1h 前的过期快照
  }
  return result
}

// —— redirect 流程：提交回调 URL ——
export async function finishOAuth(
  user: SessionUser,
  provider: ProviderId,
  redirectUrl: string,
): Promise<CollectResult> {
  const known = db.accountIdsFor(provider) // 仅当前 provider 的已知号（account_id 按 provider 独立）
  const state = parseState(redirectUrl)
  const snapshot = state ? db.getOAuthSnapshot(state) : null
  // fail-closed：真实模式下快照缺失（已消费/过期/部署前发起/无 state）→ 在 oauth-callback **之前**
  // 拒绝——空 before 会退化回抢注号池既有号；若放行到 callback 后号已落、又必孤立。
  if (!snapshot && !env.mock) return { ok: false, error: SNAPSHOT_MISSING_ERROR }
  const before = new Set(snapshot ?? [])
  const result = await cpa.finishOAuth(provider, redirectUrl, known, before)
  await isolate(result.authFileName)
  const recorded = recordIngest(user, provider, result, 'oauth')
  if (recorded.ok && state) db.deleteOAuthSnapshot(state) // 入库成功才删——失败留快照给 retry 重读，不孤立
  return recorded
}

// —— device 流程：轮询一次，ok 则落号 ——
export async function checkOAuth(
  user: SessionUser,
  provider: ProviderId,
  state: string,
): Promise<{ done: true; result: CollectResult } | { done: false; error?: string }> {
  const known = db.accountIdsFor(provider) // 仅当前 provider 的已知号
  const snapshot = state ? db.getOAuthSnapshot(state) : null
  // fail-closed 同 finishOAuth：真实模式快照缺失即拒绝，绝不带空 before 去认号
  if (!snapshot && !env.mock) return { done: false, error: SNAPSHOT_MISSING_ERROR }
  const before = new Set(snapshot ?? [])
  const r = await cpa.checkOAuth(provider, state, known, before)
  if (r.status === 'error') return { done: false, error: r.error }
  if (r.status !== 'ok') return { done: false }
  await isolate(r.ingest.authFileName)
  const recorded = recordIngest(user, provider, r.ingest, 'oauth')
  if (recorded.ok && state) db.deleteOAuthSnapshot(state) // 入库成功才删
  return { done: true, result: recorded }
}

// —— 直贴 RT（仅 codex）——
export async function ingestRT(user: SessionUser, rt: string): Promise<CollectResult> {
  const known = db.accountIdsFor('codex') // RT 仅 codex
  const result = await cpa.ingestRefreshToken(rt, known)
  await isolate(result.authFileName)
  return recordIngest(user, 'codex', result, 'rt')
}

// @deprecated v4（R1 拆考察期）：observationKind / pauseIncrement 及其原消费方（考察闭环 settle /
// 故障顺延 recordTick）已随 v4「按量计量」拆除，processPending 不再调用。两函数按任务要求保留（便于
// 将来复用、少改动）；随消费方一并移除的是 RULE_VERSION / OBSERVE_PRIORITY / observeWindowMs（考察
// 快照常量与助手，v4 无复用价值）。

// —— §3.3 判定表：inspect 探测结果 → 考察观测事件类型（与 cpamp 建议动作对齐）——
// cpamp 动作映射（P0-A）：保留→ok、禁用/限流→retry、重登→reauth、删除→reject。reauth 不入此函数
// （调用点直接转 needs_review）。decision 是 cpamp 权威动作、作主分类；reason 仅在失败类里细分 soft/hard：
//   软失败（不阻断发分，与 cpamp 内建 request-retry/cooldown 对齐）：额度耗尽 / 限流（临时可恢复）。
//   硬失败（判死）：401 / 撤权 / 失效（明确失效）。
// reason 命中细分词表→按词表；reason 不明→保守回落 decision 现有映射（reject→硬 / 其余→软）。
// ⚠️ MOCK 下 reason 由 mock inspect 给；真实 cpamp reason 结构对接时须复核此词表（见 PR 诚实标注）。
const SOFT_REASON = /usage.?limit|quota|rate.?limit|too_many|cooldown|throttl/i
const HARD_REASON = /unauthorized|invalid|revoked?|deactivat/i
export function observationKind(r: ProbeResult): ObservationKind {
  // decision=ok（cpamp 保留/启用）＝权威健康：绝不因 reason 字样把 cpamp 认可的活号误判死。
  if (r.decision === 'ok') return 'healthy'
  const reason = r.reason || ''
  if (SOFT_REASON.test(reason)) return 'soft_fail'
  if (HARD_REASON.test(reason)) return 'hard_fail'
  return r.decision === 'reject' ? 'hard_fail' : 'soft_fail'
}

// —— §3.2 故障顺延：本轮成功观测时，相对上次成功观测的「暂停增量」——
// 近似：以 worker intervalMs 为预期观测间隔。若本次距上次成功观测的 gap 远超预期（> 2× 容忍抖动），
// 判定中间存在观测空洞（停机 / 不可观测），把「超出一个预期间隔的部分」记为暂停时长（不计入考察窗口 T）。
// 2× 是工程取值（见 PR 诚实标注）。intervalMs 非正（配置异常）→ 返回 0，退化为纯 wall-clock，不误判全暂停。
export function pauseIncrement(now: number, base: number, intervalMs: number): number {
  if (intervalMs <= 0) return 0
  const gap = now - base
  return gap > intervalMs * 2 ? gap - intervalMs : 0
}

// —— 首检 → 入池（需求 §3.2 v4：考察期取消，首检通过即入池计量）——
// worker 周期调用；手动也可触发。running 锁防单进程叠跑，跨实例幂等靠 DB。
// 只拉「首检两态」submitted 待首检 / first_check 首检重试中；pooled 号本单不处理（按日计量＝R2、
// 失效巡检＝R3）。processPending 本单不发任何分（R1 只做首检入池）。
let running = false

export async function processPending(): Promise<{
  checked: number
  activated: number // 本轮入池数（对外仍叫 activated，保 worker/verify-now 调用方兼容）
  rejected: number // 本轮首检失败·退回数（删行释放唯一键）
  skipped?: boolean
}> {
  if (running) return { checked: 0, activated: 0, rejected: 0, skipped: true }
  running = true
  try {
    const pending = db.byVerifyStatus(['submitted', 'first_check'])
    if (pending.length === 0) return { checked: 0, activated: 0, rejected: 0 }

    let pooled = 0 // 本轮入池数
    let rejected = 0 // 本轮首检失败·退回数

    // 首检通过 → 入池：启用（setDisabled false）+ transition → pooled，此刻占用唯一键（§3.2）。
    //   限额/额度暂满（decision=retry）不算失败 → 一并入池等恢复（§3.2「限额不算失败，先入池」）。
    //   入池优先级 setPriority 接口层仍缺（留后续），本单只启用。启用失败→保持原态下轮重试。
    //   ⚠️ v4 三家一视同仁：不再按 pointsFor<=0 淘汰——provider 在 codex/claude/grok 内即可入池，
    //     按量折算规则（原 pointsFor）留 R2 重构。
    const enterPool = async (c: (typeof pending)[number], plan: string): Promise<void> => {
      try {
        await cpa.setDisabled(c.authFileName, false) // 首检通过→启用
      } catch {
        return // 启用失败：不入池，保持原态下轮重试
      }
      if (plan !== c.plan) db.update(c.id, { plan })
      if (db.transition(c.id, ['submitted', 'first_check'], 'pooled')) pooled++
    }

    // 首检失败·退回（§2.4/§3.2）：号 401/撤权/封号、压根没入池 → **先删 cpamp auth 文件、成功后才
    //   CAS 删 contribution 行**（仅当仍处首检两态才删，释放唯一键让用户修好重交）。顺序关键
    //   （codex xhigh 于 PR #15 指出）：若先删行、文件删失败，孤立文件会留在池里——用户重交同号时
    //   授权前快照已含该文件名（同名覆盖认不出新落）→ findNew 挡住、修好的号反而交不进来。故文件
    //   删失败＝本轮不退回、保留行（转 first_check），下轮重试删除；CAS 删行仍防误删已入池行。
    const rejectBack = async (c: (typeof pending)[number]): Promise<void> => {
      try {
        await cpa.deleteAuthFile(c.authFileName)
      } catch {
        db.transition(c.id, ['submitted'], 'first_check') // 文件还在：保留行下轮重试，不释放唯一键
        return
      }
      if (db.deleteContribution(c.id, ['submitted', 'first_check'])) rejected++ // CAS：已入池则不删
    }

    // —— codex：走 cpamp 巡检（能识别套餐 + 能登录/失效判定）——
    const codexPending = pending.filter((c) => c.provider === 'codex')
    if (codexPending.length > 0) {
      // inspect() 整体抛错（CPA 5xx/网络/巡检侧故障）＝本轮不可观测：所有 codex 首检号本轮跳过、下轮再检，
      // 绝不把「不可观测」当失败误退回。
      let probes: ProbeResult[] | null = null
      try {
        probes = await cpa.inspect()
      } catch {
        probes = null
      }
      if (probes !== null) {
        const byId = new Map(probes.map((r) => [r.accountId, r]))
        for (const c of codexPending) {
          const r = byId.get(c.accountId)
          if (!r) continue // 本轮巡检未覆盖（刚落号/掉队）→ 跳过，下轮再检
          const plan = r.plan && r.plan !== 'unknown' ? r.plan : c.plan
          if (r.decision === 'ok' || (r.decision === 'retry' && SOFT_REASON.test(r.reason || ''))) {
            // ok=能登录未封 → 入池。retry 只认「配额类」（reason 命中限额词表＝usage_limit/quota/
            // rate_limit…）＝§3.2「限额不算失败，先入池等恢复」。⚠️ retry 不全是限额：mapInspection
            // 对未分类错误/服务端异常/disable 也回 retry——这些没证实「能登录」，不能入池锁唯一键
            // （codex xhigh 于 PR #15 指出），转 first_check 下轮再查（限额恢复/问题消失后 inspect
            // 会转 ok 自然入池，只是晚点，不算失败）。
            await enterPool(c, plan)
          } else if (r.decision === 'retry') {
            // 非配额 retry（未分类/服务端异常/disable）→ 留首检循环，下轮复查
            db.transition(c.id, ['submitted'], 'first_check')
          } else if (r.decision === 'reject') {
            // 401/撤权/失效＝首检失败 → 退回（删文件 + 删行释放唯一键）
            await rejectBack(c)
          } else if (r.decision === 'reauth') {
            // OAuth 失效需重授权 → 转人工复核
            db.transition(c.id, ['submitted', 'first_check'], 'needs_review')
          }
        }
      }
    }

    // —— claude / grok：cpamp 无深度巡检，OAuth 成功即视为能用（活号才能授权）→ 首检直接入池。——
    //    保持老实现「能授权即有效」的简化；三家一视同仁，v4 无判死概念（能调用即计量、明确失效才停）。
    const otherPending = pending.filter((c) => c.provider !== 'codex')
    for (const c of otherPending) {
      await enterPool(c, c.plan)
    }

    return { checked: pending.length, activated: pooled, rejected }
  } finally {
    running = false
  }
}
