import { randomBytes } from 'crypto'
import { cpa, type IngestResult, type ProviderId, type StartResult } from './cpa'
import { db, type Contribution } from './db'
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

// —— 考察期常量（§3.4 冻结快照用）——
const RULE_VERSION = 'rules-v1' // 检测规则版本快照
const OBSERVE_PRIORITY = 10 // 入池优先级快照占位（实际 setPriority 留 P2c）

// 考察窗口 T（毫秒）：优先 app_config 可配（seedDefaults 已播种）；缺省 mock 8s 便于演示 / 真实 24h。
// 非法/缺失/非正数一律降级为兜底默认。进考察那刻由 startObservation 冻结当时的 T。
function observeWindowMs(): number {
  const raw = db.getConfig('observe_window_ms')
  const n = raw == null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : env.mock ? 8000 : 86_400_000
}

// —— 巡检 → 状态机（需求 §3.2 考察期闭环）——
// worker 周期调用；手动也可触发。running 锁防单进程叠跑，跨实例幂等靠 DB。
// 拉「进行中」三态：submitted 待首检 / first_check 首检重试中 / observing 考察中。
//   首检通过 → 启用 + 冻结快照 + 进 observing；考察期每轮观测 + 到期发分/硬失败判死。
let running = false

export async function processPending(): Promise<{
  checked: number
  activated: number
  rejected: number
  skipped?: boolean
}> {
  if (running) return { checked: 0, activated: 0, rejected: 0, skipped: true }
  running = true
  try {
    const pending = db.byVerifyStatus(['submitted', 'first_check', 'observing'])
    if (pending.length === 0) return { checked: 0, activated: 0, rejected: 0 }

    let granted = 0 // 本轮到期发分数（对外仍叫 activated，保调用方兼容）
    let failed = 0 // 本轮判死数（无规则/硬失败/首检拒绝）

    // ① 首检通过 → 进考察：启用 + 冻结快照（窗口/分值/规则版本/优先级）+ transition observing。
    //    无发分规则（不接受该类型）→ 判死。启用失败→保持原态下轮重试。
    const enterObservation = async (c: (typeof pending)[number], plan: string): Promise<void> => {
      const pts = db.pointsFor(c.provider, plan)
      if (pts <= 0) {
        try {
          await cpa.deleteAuthFile(c.authFileName)
        } catch {
          /* 删除失败下轮重试 */
        }
        if (db.transition(c.id, ['submitted', 'first_check'], 'failed')) failed++
        return
      }
      try {
        await cpa.setDisabled(c.authFileName, false) // 首检通过→启用（查 HTTP 状态）
      } catch {
        return // 启用失败：不进考察，保持原态下轮重试
      }
      if (plan !== c.plan) db.update(c.id, { plan })
      // §3.4 冻结：CAS 守 observe_start_at IS NULL，进考察那刻冻结窗口T/分值/规则/优先级；
      // 重入不重启计时、不被后台改配污染。快照冻结后再 transition，crash 重入仍用原快照。
      db.startObservation(c.id, {
        windowMs: observeWindowMs(),
        points: pts,
        ruleVersion: RULE_VERSION,
        priority: OBSERVE_PRIORITY,
      })
      db.transition(c.id, ['submitted', 'first_check'], 'observing')
    }

    // ② 考察驱动（对 observing 的号）：硬失败判死 / 到期发分 / 未到期保持。
    //    发分用冻结的 snapshotPoints（不重查规则）；awardPoints 幂等，重入不重复发分。
    const settle = async (c: (typeof pending)[number]): Promise<void> => {
      if (db.hasHardFailure(c.id)) {
        // 考察窗口内出现硬失败 → 判死，不发分（删号 best-effort）
        try {
          await cpa.deleteAuthFile(c.authFileName)
        } catch {
          /* 删除失败下轮重试 */
        }
        if (db.transition(c.id, ['observing'], 'failed')) failed++
        return
      }
      const snap = db.getObservationSnapshot(c.id)
      if (snap.observeStartAt == null || snap.observeWindowMs == null) return // 防御：未冻结不结算
      // 故障顺延（§3.2 不可观测暂停计时）本单不做：计时用 wall-clock 不暂停——最小可用，留 P2b。
      if (Date.now() - snap.observeStartAt < snap.observeWindowMs) return // 未到期：保持 observing，下轮再看
      const pts = snap.snapshotPoints ?? 0 // 冻结值，不重查规则
      db.awardPoints(c.linuxdoId, pts, 'contribution', c.id) // 幂等（UNIQUE(reason,ref)）
      db.update(c.id, { points: pts, rewardStatus: 'granted' })
      if (db.transition(c.id, ['observing'], 'granted')) granted++
    }

    // —— codex：走 cpamp 巡检（能识别套餐 + 额度/失效）——
    const codexPending = pending.filter((c) => c.provider === 'codex')
    if (codexPending.length > 0) {
      const byId = new Map((await cpa.inspect()).map((r) => [r.accountId, r]))
      for (const c of codexPending) {
        const r = byId.get(c.accountId)
        if (!r) continue // 本轮巡检未覆盖（可能刚入池），下轮再判
        const plan = r.plan && r.plan !== 'unknown' ? r.plan : c.plan
        if (c.verifyStatus === 'observing') {
          // 考察驱动：cpamp inspect 结果映射为观测事件（本单简化，真实差异化巡检 P2b）。
          // reauth 直接转人工复核，不作为观测事件。
          if (r.decision === 'reauth') {
            db.transition(c.id, ['observing'], 'needs_review')
            continue
          }
          const kind =
            r.decision === 'ok' ? 'healthy' : r.decision === 'reject' ? 'hard_fail' : 'soft_fail'
          db.addObservation(c.id, kind, `inspect:${r.decision}`)
          await settle(c)
        } else {
          // 首检（submitted/first_check）：decision 决定去向
          if (r.decision === 'ok') {
            await enterObservation(c, plan) // 首检通过→进考察
          } else if (r.decision === 'reject') {
            try {
              await cpa.deleteAuthFile(c.authFileName)
            } catch {
              /* 同上 */
            }
            if (db.transition(c.id, ['submitted', 'first_check'], 'failed')) failed++
          } else if (r.decision === 'reauth') {
            db.transition(c.id, ['submitted', 'first_check'], 'needs_review')
          } else {
            // retry：临时（限流/额度满），保留隔离，转 first_check 下轮复检
            db.transition(c.id, ['submitted'], 'first_check')
          }
        }
      }
    }

    // —— claude / grok：cpamp 无巡检。OAuth 成功即视为有效号（活号才能授权），套餐无法识别。
    //    首检直接进考察；考察期本单简化为直接 healthy（真实差异化复检留 P2c）。——
    const otherPending = pending.filter((c) => c.provider !== 'codex')
    for (const c of otherPending) {
      if (c.verifyStatus === 'observing') {
        db.addObservation(c.id, 'healthy', 'assume-ok')
        await settle(c)
      } else {
        await enterObservation(c, c.plan) // 首检通过→进考察
      }
    }

    return { checked: pending.length, activated: granted, rejected: failed }
  } finally {
    running = false
  }
}
