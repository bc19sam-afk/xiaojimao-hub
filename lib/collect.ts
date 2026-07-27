import { randomBytes } from 'crypto'
import { cpa, type AuthFile, type IngestResult, type ProbeResult, type ProviderId, type StartResult } from './cpa'
import { db, shortAccountLabel, type Contribution, type ObservationKind } from './db'
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
  // 修好重交成功入库 → 清掉**本人**该号旧退回记录，dashboard 的「未收下」提示随之消失（codex xhigh 于 PR #18）
  db.clearRejections(contribution.linuxdoId, provider, contribution.accountId)
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

// —— 巡检结果索引键：(provider, accountId) 复合键（对接-R2c）——
// 身份纪律全系统是复合 canonical key（P1a/P1c）：account_id 命名空间按 provider 独立，跨 provider
// 撞同一 id 是合法的不同号（见 cpa.ts knownAccountIds 注释）。裸 accountId 建索引＝把 A 家的判定
// 套到 B 家号上（误停在用的号 / 未验证的号误入池）。分隔符 '\0' 与 getDailyUsage、下面 present 集同款。
function probeKey(provider: string | undefined, accountId: string): string {
  return `${provider ?? ''}\0${accountId}`
}
// 取本号的巡检结果：先按 (provider, accountId) 精确查，未命中回落查「无 provider」键。
// ⚠️ 回落不可省：线上 cpamp 版本未知，老版本巡检结果可能不带 provider 字段；若只查复合键，
// provider 缺失时全部查不到 → 首检号永不入池、存活巡检永不判失效＝静默零收益。带回落＝provider
// 在时消除跨 provider 撞键，provider 缺时行为与本改动前完全一致。
function findProbe(
  byKey: Map<string, ProbeResult>,
  c: { provider: string; accountId: string }, // Contribution.provider 是 string（与下面 present 集同）
): ProbeResult | undefined {
  return byKey.get(probeKey(c.provider, c.accountId)) ?? byKey.get(probeKey(undefined, c.accountId))
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
  // 🔴 本轮 cpa.inspect() 整体抛错（P6-R2 复审三轮第 2 条）：**只是给调用方的健康信号**，
  //    不改收号语义（下面那处 catch 照旧把号跳过、绝不误退回——那是 PR #15 定的纪律）。
  //    没有它的话，CPA 持续宕机时 processPending 一路返回 {checked:n,activated:0,rejected:0}
  //    且不抛，worker 的 healthy 恒 true → dead-man 心跳照打，而收号链路实际是断的：
  //    docs §6 承诺「心跳证明后台 worker 还在正常干活」，实测复现过这条假绿。
  //    ⚠️ 只在**本轮真的需要 inspect**（有 codex 待首检号）且它抛了时才为 true；没有 codex 待检号
  //    时压根不调 inspect，此时缺省 undefined ＝「本轮没有可观测到的 CPA 故障」，不能误报不健康。
  inspectFailed?: boolean
  // 🔴 本轮 CPA 写操作（setDisabled/deleteAuthFile/setPriority）失败（P6-R2 R6③，codex R5 指出）：
  //    **只是给调用方的健康信号**，收号语义分毫未动（enterPool / rejectBack 的 catch 块原样保留号、
  //    下轮重试）。与 inspectFailed 同根因：CPA 写端点 5xx/网络不通时 catch 块吞掉异常、保留行待重试，
  //    **但不抛**。processPending 返回时只回传 activated/rejected 计数、无失败信号 → worker 的
  //    healthy 恒 true → 心跳照打，而 CPA 写端点故障会阻塞所有激活/拒绝（待检号堆积在 first_check、
  //    零号入池）。故额外传播此健康信号。
  //    ⚠️ 缺省 undefined ＝本轮无待检号/所有写操作成功 → 按健康算，不能因「本轮没活干」就误报不健康。
  writeFailed?: boolean
}> {
  if (running) return { checked: 0, activated: 0, rejected: 0, skipped: true }
  running = true
  try {
    const pending = db.byVerifyStatus(['submitted', 'first_check'])
    if (pending.length === 0) return { checked: 0, activated: 0, rejected: 0 }

    // 入池优先级：本轮 read-once（§2.5，缺省 10、后台可调），enterPool 闭包引用、不每号查库。
    // 置于空池早返回之后：worker 空转 tick（无待处理号）不白读库。
    const poolPriority = db.getPoolPriority()
    let pooled = 0 // 本轮入池数
    let rejected = 0 // 本轮首检失败·退回数
    let inspectFailed = false // 本轮 inspect 是否整体抛错（仅作健康信号，不改收号语义）
    let writeFailed = false // 本轮 CPA 写操作（setDisabled/deleteAuthFile/setPriority）是否失败（P6-R2 R6③）

    // 首检通过 → 入池：启用（setDisabled false）+ 设高优先级（best-effort）+ transition → pooled，
    //   此刻占用唯一键（§3.2）。限额/额度暂满（decision=retry）不算失败 → 一并入池等恢复
    //   （§3.2「限额不算失败，先入池」）。入池优先级已接线（§2.5，缺省 10、后台可调）：best-effort——
    //   设失败不挡入池（号已启用能计量，优先级设失败仅损号主上浮），下轮不重设（细化重试留后续单）。
    //   realClient.setPriority 端点已按 CLIProxyAPI 上游源码核对（PATCH /auth-files/fields）、真发/重试留对接-R3；MOCK 下已验接线。启用失败→不入池、保持原态下轮重试。
    //   ⚠️ v4 三家一视同仁：不再按 pointsFor<=0 淘汰——provider 在 codex/claude/grok 内即可入池，
    //     按量折算规则（原 pointsFor）留 R2 重构。
    const enterPool = async (c: (typeof pending)[number], plan: string): Promise<void> => {
      try {
        await cpa.setDisabled(c.authFileName, false) // 首检通过→启用
      } catch {
        writeFailed = true // 仅置健康信号；重试语义原样不动
        return // 启用失败：不入池，保持原态下轮重试
      }
      try {
        await cpa.setPriority(c.authFileName, poolPriority) // 入池设高优先级（§2.5，缺省 10、后台可调）
      } catch {
        writeFailed = true // 仅置健康信号（R6③）
        // best-effort：号已启用能计量，优先级设失败仅损号主上浮、不挡入池（挡入池=号主零收益、更糟）。
        // 号已 pooled 后 processPending 只扫 submitted/first_check → 本轮不重设、无自动补设。残余窄窗：
        // 管理员调高优先级后恰逢瞬时失败 → 该号停在缺省 10（=cpamp 上游默认，失败无害）无自动重试；
        // 重设/补设机制留对接-R3（realClient 真写验证后细化）。
        console.warn('[collect] setPriority 失败', shortAccountLabel(c.provider, c.accountId)) // §8 掩码（claude accountId=邮箱=PII）
      }
      if (plan !== c.plan) db.update(c.id, { plan })
      if (db.transitionToPool(c.id, ['submitted', 'first_check'], Date.now())) {
        pooled++ // 转态+写 pooled_at 同一原子 UPDATE（首次进池时刻＝结算资格判据 migration 010）
      }
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
        writeFailed = true // 仅置健康信号（R6③）
        db.transition(c.id, ['submitted'], 'first_check') // 文件还在：保留行下轮重试，不释放唯一键
        return
      }
      if (db.deleteContribution(c.id, ['submitted', 'first_check'])) {
        // 删行成功（唯一键已释放）→ 记一条**中性人话**退回提示（§3.2 告知用户「登录失败/被封、未收」），
        // 让号从 dashboard 消失时用户知道原委、可修好重交。绝不透传 CPA 报错原文（§8）。
        db.recordRejection({
          linuxdoId: c.linuxdoId,
          provider: c.provider,
          accountId: c.accountId,
          reason: '登录失败或已被封号，未入池',
        })
        rejected++ // CAS：已入池则不删（recordRejection 也不会触发）
      }
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
        inspectFailed = true // 仅置健康信号；跳过语义原样不动（见返回类型上的说明）
      }
      if (probes !== null) {
        const byKey = new Map(probes.map((r) => [probeKey(r.provider, r.accountId), r]))
        for (const c of codexPending) {
          const r = findProbe(byKey, c)
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

    return { checked: pending.length, activated: pooled, rejected, inspectFailed, writeFailed }
  } finally {
    running = false
  }
}

// —— 号存活巡检（P2-R3，需求 §3.5「明确失效才停、限额/零用量不算停」）——
// 号进 pooled 后无人再看它死活——死号会一直挂 pooled、settle 侧也白扫。本函数由 worker 周期调用，
// **只碰 pooled 态**（绝不动首检两态 submitted/first_check，与 processPending 首检逻辑正交）：明确失效
// → stopped，停止新计量。三家判失效策略不同（诚实标注见 PR）：
//   codex —— cpamp 深度巡检 inspect()：reject（401/撤权/删除＝明确失效）→ stopped；retry（限额/额度暂满，
//     §3.2「限额不算失败」）→ 保持 pooled；reauth（OAuth 失效需重授权）→ needs_review；ok/未覆盖 → 保持。
//     inspect 整体抛错＝本轮不可观测：所有 codex 跳过、下轮再看，绝不把「不可观测」当失效误停（仿 processPending）。
//   claude/grok —— cpamp 无深度 inspect，保守判失效：listAuthFiles() 里该号（provider+accountId）文件
//     已不存在（被删/撤销）→ stopped；仍存在（含 disabled——§3.3 管理员手动禁用/限额不算失败）→ 保持 pooled。
//     listAuthFiles 抛错 → 本轮全跳过（同不误判死）。
// stopped 后 settleDailyUsage 只结历史日（R2 行为不变，「昨天有量今天停用」的欠薪照补，不受影响）。
let healthRunning = false
// 存活巡检节流（codex xhigh 于 PR #18 指出）：默认 worker tick=8s，每轮都全量 inspect()（codex 巡检可
// 轮询达 30s）＝持续满负荷。巡检该分钟级、比结算勤即可；此处限至少隔 5 分钟跑一次（now/force 供测试）。
const HEALTH_INTERVAL_MS = 5 * 60_000
let lastHealthAt = 0
// 🔴 R6-P1①（codex R5 终审）：持久化 CPA 巡检失败状态，跨节流窗传播到后续 throttled tick。
//    修复前：lastHealthAt 在 try 开头推进 → 失败后的下一轮（8s 后）被节流 early return、只回
//    { skipped:true }、缺 inspectFailed → worker 判健康 → 持续故障期每 5 分钟窗只有首 tick 抑制
//    心跳、后续 ~36 tick 照打 → dead-man 假绿。
//    修复后：本轮真跑时更新此标志（成功清零、失败保持），throttled skip 时从这里传播 → 故障期
//    所有 tick 都判不健康，直到下次真跑成功才清零 → 心跳在整个故障窗持续抑制。
let lastInspectFailed = false

export async function checkPooledHealth(
  now: number = Date.now(),
  opts: { force?: boolean } = {},
): Promise<{
  checked: number // 本轮巡检的 pooled 号数
  stopped: number // 本轮判失效停用数
  skipped?: boolean
  // 🔴 本轮被 **healthRunning 锁** 挡住（P6-R2 R4②）：**只是给调用方的健康信号**，存活巡检
  //    语义分毫未动。与 settleDailyUsage 的 lockHeld 同根因：上一轮卡在 cpa.inspect() 或
  //    listAuthFiles() 的无超时 fetch 里没回来 → 后续 tick 拿到 skipped=true 但 worker.ts
  //    只看 stopped、healthy 保持 true → 心跳照打，而存活巡检实际已卡死。
  //    ⚠️ 节流 skip（now - lastHealthAt < INTERVAL）是正常行为，不能并进健康判据，故单列标志。
  lockHeld?: boolean
  // 🔴 本轮 CPA 巡检接口（inspect / listAuthFiles）不可用（P6-R2 R6②，codex R5 指出）：
  //    与 processPending 的 inspectFailed 同根因——CPA 5xx/网络不通时 catch 块吞掉异常、跳过
  //    本轮所有号（存活巡检纪律：不可观测≠失效，绝不误停），**但不抛**。lastHealthAt 在
  //    try 前已推进 → 后续 tick 被当正常节流 skip、继续发心跳，而存活巡检实际断了。
  //    ⚠️ 缺省 undefined ＝本轮无 pooled 号/全是 codex 且 inspect 成功 → 按健康算，不能因
  //       「本轮没活干」或「部分 provider 成功」就误报不健康。
  inspectFailed?: boolean
}> {
  if (healthRunning) return { checked: 0, stopped: 0, skipped: true, lockHeld: true }
  if (!opts.force && now - lastHealthAt < HEALTH_INTERVAL_MS) {
    // 🔴 R6-P1①：节流 skip 时也传播上次真跑的巡检失败状态，防故障期每窗只有首 tick 抑心跳、其余照打
    return { checked: 0, stopped: 0, skipped: true, inspectFailed: lastInspectFailed }
  }
  healthRunning = true
  let inspectFailed = false // 本轮 CPA 巡检接口是否不可用（仅作健康信号，不改存活巡检语义）
  try {
    lastHealthAt = now
    const pooled = db.byVerifyStatus(['pooled'])
    if (pooled.length === 0) return { checked: 0, stopped: 0 }
    let stopped = 0

    // —— codex：cpamp 深度巡检 ——
    const codexPooled = pooled.filter((c) => c.provider === 'codex')
    if (codexPooled.length > 0) {
      let probes: ProbeResult[] | null = null
      try {
        probes = await cpa.inspect()
      } catch {
        probes = null // 不可观测：本轮跳过所有 codex，绝不误判死
        inspectFailed = true // 仅置健康信号；跳过语义原样不动
      }
      if (probes !== null) {
        const byKey = new Map(probes.map((r) => [probeKey(r.provider, r.accountId), r]))
        for (const c of codexPooled) {
          const r = findProbe(byKey, c)
          if (!r) continue // 本轮巡检未覆盖 → 保持 pooled，下轮再查
          if (r.decision === 'reject') {
            // 401/撤权/删除＝明确失效 → 停用（CAS 守 pooled，防并发/过期结果误停已转他态的号）
            if (db.transition(c.id, ['pooled'], 'stopped')) stopped++
          } else if (r.decision === 'reauth') {
            // OAuth 失效需重授权 → 转人工复核
            db.transition(c.id, ['pooled'], 'needs_review')
          }
          // ok / retry（限额不算失败，§3.2）→ 保持 pooled，不动
        }
      }
    }

    // —— claude / grok：无深度 inspect，文件存在性保守判失效 ——
    const otherPooled = pooled.filter((c) => c.provider !== 'codex')
    if (otherPooled.length > 0) {
      let files: AuthFile[] | null = null
      try {
        files = await cpa.listAuthFiles()
      } catch {
        files = null // 拉不到号池清单：本轮跳过，绝不误判死
        inspectFailed = true // 仅置健康信号；跳过语义原样不动
      }
      // ⚠️ 空清单保护（codex xhigh 于 PR #18 指出）：real client 把缺失 files 字段归一为 []，一次 200
      // 空响应（如 {}）会让下面把**整个** claude/grok 池判失效停用（stopped 无恢复路径 + 锁唯一键）。
      // 空清单更可能是 cpamp glitch（正巡检的这些号至少该在池里）→ 视为不可观测、本轮跳过、不停用。
      // 真「号池全空」极罕见，宁可漏停也不错停整池。（连续多轮确认缺失可留后续单细化。）
      // 🔴 R4-P2③（codex R6 指出）：这条空清单分支与上面的 catch **同属「本轮不可观测」**，健康信号
      //    必须一并置位。此前 inspectFailed 只在 catch 里置 → 200 空响应这条路径上，存活巡检实际
      //    全跳过、却一路报健康 → dead-man 心跳照打，运维看不见「巡检已瘫」。
      //    ⚠️ 只在**有 pooled claude/grok 号**时才算异常（本分支已在 otherPooled.length > 0 内）；
      //       池里压根没这类号时不会走到这里，不会误报。
      if (files !== null && files.length === 0) {
        inspectFailed = true // 仅置健康信号；跳过语义原样不动（绝不误停整池）
      }
      if (files !== null && files.length > 0) {
        // 现存号身份集（provider+accountId）：只认能识别 provider 且有稳定 id 的文件。'\0' 作分隔符
        // （不会出现在 provider/id 里），与 settle.ts 同款按 (provider, accountId) 划界。
        const present = new Set(
          files.filter((f) => f.provider && f.accountId).map((f) => f.provider + '\0' + f.accountId),
        )
        for (const c of otherPooled) {
          if (!present.has(c.provider + '\0' + c.accountId)) {
            // 文件不存在＝被删/撤销＝明确失效 → 停用（CAS 守 pooled）
            if (db.transition(c.id, ['pooled'], 'stopped')) stopped++
          }
          // 文件仍在（含 disabled）→ 保持 pooled
        }
      }
    }

    return { checked: pooled.length, stopped, inspectFailed }
  } finally {
    // 🔴 R6-P1①：本轮真跑完成 → 更新持久化的失败标志（成功清零/失败保持），供后续 throttled tick 传播。
    //    放 finally 而非 return 前：`pooled.length === 0` 那条 early return 也要清零，否则「故障期间
    //    池子恰好清空」会把 true 永久钉住、心跳再也不发（真跑成功却报不健康）。
    lastInspectFailed = inspectFailed
    healthRunning = false
  }
}

// 测试用：清空存活巡检的时刻缓存与持久化失败标志（生产无调用方）
export function __resetHealthThrottle(): void {
  lastHealthAt = 0
  lastInspectFailed = false
}
