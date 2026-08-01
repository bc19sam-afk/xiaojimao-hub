import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { assertSchemaCurrent, migrate, readSchemaVersion } from './migrate'
import { env } from './env'
import { assertDatabaseReady } from './readiness'

// ============================================================================
// SQLite 数据层（Node 26 内置 node:sqlite，免原生依赖）
//
// 相比原 JSON 文件，提供真正的：
//   - account_id UNIQUE 约束（防同一号重复贡献/重复领奖）
//   - 原子状态转移（compare-and-set）
//   - 幂等发奖（仅当未 granted 才写码，跨连接/实例安全）
// ============================================================================

export interface Contribution {
  id: string
  linuxdoId: number
  username: string
  accountId: string
  email: string
  provider: string // codex / claude / grok
  plan: string
  method: 'oauth' | 'rt'
  authFileName: string
  // 需求 §3.2 五态（v4 按量计量，考察期取消）：submitted 已提交 / first_check 首检中 /
  // pooled 在池计量中 / stopped 已停用 / needs_review 待人工复核
  verifyStatus:
    | 'submitted'
    | 'first_check'
    | 'pooled'
    | 'stopped'
    | 'needs_review'
  points: number // 验证通过后发放的积分（0=未发/未通过）
  rewardStatus: 'waiting' | 'granted' | 'none'
  rewardText: string
  rewardNote: string
  rewardCode?: string
  createdAt: number
  updatedAt: number
  // 考察期快照（P2a-1）：进入考察时冻结；未进考察时均为 undefined（列 null→undefined）
  observeStartAt?: number // 进入考察的时刻＝计时起点
  observeWindowMs?: number // 考察窗口 T 的快照
  snapshotPoints?: number // 分值快照（进考察时按当时规则算好、冻结）
  snapshotRuleVersion?: string // 检测规则版本快照
  snapshotPriority?: number // 入池优先级快照
  // 首次进池时刻（P2-R3）：结算资格判据——非空＝入过池（该按量结算历史日）；null＝从没入池
  pooledAt?: number
}

export interface OAuthProviderLease {
  provider: string
  linuxdoId: number
  leaseToken: string
  now: number
  expiresAt: number
}

export interface OAuthSessionCreate {
  state: string
  fileNames: string[]
  linuxdoId: number
  provider: string
  leaseToken: string
  createdAt: number
  expiresAt: number
  hardExpiresAt: number
  authorizationUrl: string
  flow: 'redirect' | 'device'
  userCode?: string
}

export type OAuthSessionClaim =
  | { status: 'claimed'; fileNames: string[]; leaseToken: string; operationToken: string }
  | { status: 'busy' }
  | { status: 'cancelled' }
  | { status: 'invalid' }

export interface OAuthSessionRecovery {
  provider: string
  state: string
  url: string
  flow: 'redirect' | 'device'
  userCode?: string
  expiresAt: number
}

export type OAuthSessionCancel =
  | { status: 'cancelled'; leaseToken: string; needsUpstreamCancel: boolean }
  | { status: 'conflict' }
  | { status: 'invalid' }

export type OAuthSessionFinalization =
  | { status: 'finalizing' }
  | { status: 'cancelled' }
  | { status: 'stale' }

export interface OAuthIngestFinalization {
  state: string
  provider: string
  linuxdoId: number
  leaseToken: string
  operationToken: string
  now: number
  contribution?: Contribution
}

export type OAuthIngestFinalizationResult =
  | { status: 'committed' }
  | { status: 'duplicate' }
  | { status: 'cancelled' }
  | { status: 'stale' }

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')

interface DbFileIdentity {
  dev: bigint
  ino: bigint
}

function dbFileIdentity(): DbFileIdentity | null {
  if (DB_PATH === ':memory:') return null
  const stat = fs.statSync(DB_PATH, { bigint: true })
  return { dev: stat.dev, ino: stat.ino }
}

function sameDbFile(a: DbFileIdentity, b: DbFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function openDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const d = new DatabaseSync(DB_PATH)
  try {
    // busy_timeout 必须先设：它一设即生效且自身不取锁，随后所有取锁语句（含 WAL 建立）
    // 都受这 5s 等待保护。若顺序颠倒，next build 多 worker 同刻 openDb 争 WAL 建立
    // 的短暂排他锁时，journal_mode=WAL 会以 busy_timeout=0 立刻抛 "database is locked"（无重试）。
    d.exec('PRAGMA busy_timeout = 5000')
    d.exec('PRAGMA journal_mode = WAL')
    // 迁移纪律：生产（非 mock）只校验 schema 版本，迁移由部署步骤 `npm run migrate` 执行；
    // mock（开发/演示）保持启动自动迁移。
    if (env.mock) migrate(d)
    else assertSchemaCurrent(d)
    return d
  } catch (error) {
    d.close()
    throw error
  }
}

export { seedDefaults } from './seed-defaults'

// 跨热更新复用同一连接。连接本身惰性创建：DB-backed 模块可以安全完成 ESM 求值；若坏库令
// openDb() 失败，本次调用抛错但模块不会进入 rejected-module cache，修库后下一次调用会重新尝试。
// 文件身份必须与连接一起缓存；若路径被原子换库，不能把旧常驻连接重新标成健康。
const g = globalThis as unknown as {
  __appDb?: DatabaseSync
  __appDbPath?: string
  __appDbIdentity?: DbFileIdentity | null
}
function connection(): DatabaseSync {
  if (g.__appDb) return g.__appDb
  const current = openDb()
  try {
    g.__appDbPath = DB_PATH
    g.__appDbIdentity = dbFileIdentity()
    g.__appDb = current
    return current
  } catch (error) {
    current.close()
    throw error
  }
}
const conn = new Proxy({} as DatabaseSync, {
  get(_target, property) {
    const current = connection()
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

interface Row {
  id: string
  linuxdo_id: number
  username: string
  account_id: string
  email: string
  provider: string
  plan: string
  method: string
  auth_file_name: string
  verify_status: string
  points: number
  reward_status: string
  reward_text: string
  reward_note: string
  reward_code: string | null
  created_at: number
  updated_at: number
  observe_start_at: number | null
  observe_window_ms: number | null
  snapshot_points: number | null
  snapshot_rule_version: string | null
  snapshot_priority: number | null
  pooled_at: number | null
}

function toContribution(r: Row): Contribution {
  return {
    id: r.id,
    linuxdoId: r.linuxdo_id,
    username: r.username,
    accountId: r.account_id,
    email: r.email,
    provider: r.provider,
    plan: r.plan,
    method: r.method as Contribution['method'],
    authFileName: r.auth_file_name,
    verifyStatus: r.verify_status as Contribution['verifyStatus'],
    points: r.points,
    rewardStatus: r.reward_status as Contribution['rewardStatus'],
    rewardText: r.reward_text,
    rewardNote: r.reward_note,
    rewardCode: r.reward_code ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // null→undefined（?? 只吞 null/undefined，不吞 0——分值/优先级 0 是合法快照值，须保留）
    observeStartAt: r.observe_start_at ?? undefined,
    observeWindowMs: r.observe_window_ms ?? undefined,
    snapshotPoints: r.snapshot_points ?? undefined,
    snapshotRuleVersion: r.snapshot_rule_version ?? undefined,
    snapshotPriority: r.snapshot_priority ?? undefined,
    pooledAt: r.pooled_at ?? undefined,
  }
}

function insertContribution(c: Contribution): boolean {
  return conn
    .prepare(
      `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider, account_id) DO NOTHING`,
    )
    .run(
      c.id, c.linuxdoId, c.username, c.accountId, c.email, c.provider, c.plan, c.method, c.authFileName,
      c.verifyStatus, c.points, c.rewardStatus, c.rewardText, c.rewardNote, c.rewardCode ?? null,
      c.createdAt, c.updatedAt,
    ).changes === 1
}

// 考察期观测事件的合法类型（封死取值，防拼错——如 'hard-fail' 会被 hasHardFailure 漏判、
// 导致本该判死的号发分）。healthy 正向健康 / hard_fail 硬失败判死 / soft_fail 软失败不阻断 / unknown 不可观测
export type ObservationKind = 'healthy' | 'hard_fail' | 'soft_fail' | 'unknown'
const OBSERVATION_KINDS: ReadonlySet<string> = new Set<ObservationKind>([
  'healthy',
  'hard_fail',
  'soft_fail',
  'unknown',
])

// 考察期观测事件（P2a-1）：一行=一次观测。
export interface Observation {
  id: number
  contributionId: string
  observedAt: number
  kind: ObservationKind
  detail: string
  createdAt: number
}

interface ObsRow {
  id: number
  contribution_id: string
  observed_at: number
  kind: string
  detail: string
  created_at: number
}

function toObservation(r: ObsRow): Observation {
  return {
    id: r.id,
    contributionId: r.contribution_id,
    observedAt: r.observed_at,
    kind: r.kind as ObservationKind, // 写入侧 addObservation 已校验，落库值必属合法集
    detail: r.detail,
    createdAt: r.created_at,
  }
}

// 按日结算行（P2-R2/P7-R1）：daily_settlements 一行 = 某号某自然日的累计结算水位
interface DsRow {
  id: number
  contribution_id: string
  date: string
  provider: string
  account_id: string
  call_count: number
  points: number
  settled_at: number
}
function toDailySettlement(r: DsRow): DailySettlement {
  return {
    id: r.id,
    contributionId: r.contribution_id,
    date: r.date,
    provider: r.provider,
    accountId: r.account_id,
    callCount: r.call_count,
    points: r.points,
    settledAt: r.settled_at,
  }
}

// ===== LDC 每日限量（P3-R2）=====
// LDC＝合伙人的 linux.do 币。完全复用 R1 的 CDK 发码履约，只多两件事：码带面额（cdk_codes.face_value）、
// 每日限量（当日已发 LDC 面额之和 ≤ 每日额度，按服务器本地自然日重置）。额度存 app_config KV、缺省 2000。
const LDC_DAILY_QUOTA_KEY = 'ldc_daily_quota'
const LDC_DAILY_QUOTA_DEFAULT = 2000

// 入池优先级（§2.5/§7.1）：贡献号入池即设的全局优先级（cpamp 数字越大越优先），后台可调、缺省 10。
// 存 app_config KV、复用通用 getConfig/setConfig（无需迁移）。
const POOL_PRIORITY_KEY = 'pool_priority'
const POOL_PRIORITY_DEFAULT = 10

// 毫秒 → 所在自然日的 [今日 0 点, 明日 0 点) 毫秒半开区间（服务器本地时区）。与 lib/settle.ts / lib/cpa.ts
// 的 dayStr（'YYYY-MM-DD' 日键）是**同一「服务器本地自然日」口径**，只是形式不同：额度判定要判「issued_at
// 落在今日」＝时间戳落在此区间，需要的是毫秒边界而非日键串，故取此形，非另立第三种日期口径。用本地 getter
// （setHours/setDate 走本地时区）与 dayStr 一致；setDate(+1) 取次日 0 点＝跨月/年/夏令时都安全（按日历日进位）。
function localDayBounds(ms: number): { start: number; end: number } {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  const start = d.getTime()
  d.setDate(d.getDate() + 1)
  return { start, end: d.getTime() }
}

export const db = {
  all(): Contribution[] {
    return (conn.prepare('SELECT * FROM contributions').all() as unknown as Row[]).map(toContribution)
  },

  // 某 provider 已入库的 accountId 列表（收号链路按 provider 判重用；account_id 命名空间按 provider 独立）
  accountIdsFor(provider: string): string[] {
    return (
      conn.prepare('SELECT account_id FROM contributions WHERE provider = ?').all(provider) as unknown as {
        account_id: string
      }[]
    ).map((r) => r.account_id)
  },

  byUser(linuxdoId: number): Contribution[] {
    const rows = conn
      .prepare('SELECT * FROM contributions WHERE linuxdo_id = ? ORDER BY created_at DESC')
      .all(linuxdoId) as unknown as Row[]
    return rows.map(toContribution)
  },

  byVerifyStatus(statuses: string[]): Contribution[] {
    if (statuses.length === 0) return []
    const ph = statuses.map(() => '?').join(',')
    const rows = conn
      .prepare(`SELECT * FROM contributions WHERE verify_status IN (${ph}) ORDER BY created_at ASC`)
      .all(...statuses) as unknown as Row[]
    return rows.map(toContribution)
  },

  // 结算资格号（P2-R3，codex xhigh 于 PR #18 指出）：**入过池**的号（pooled_at 非空），不看当前
  // verify_status——含 pooled（在池计量）+ stopped/needs_review（存活巡检转态后补结历史欠薪）。
  // 从没入池的（首检 reauth→needs_review、submitted/first_check）pooled_at 为 null、不在此集，
  // 绝不给从没入池的号错发分。
  eligibleForSettlement(): Contribution[] {
    return (
      conn
        .prepare('SELECT * FROM contributions WHERE pooled_at IS NOT NULL')
        .all() as unknown as Row[]
    ).map(toContribution)
  },

  // 插入；(provider, account_id) 冲突则不插入并返回 duplicate=true（依赖复合 UNIQUE 约束，原子防重）
  insertUnique(c: Contribution): { duplicate: boolean } {
    return { duplicate: !insertContribution(c) }
  },

  // 通用部分更新（供状态/字段调整）
  update(id: string, patch: Partial<Contribution>): void {
    const map: Record<string, string> = {
      verifyStatus: 'verify_status',
      points: 'points',
      provider: 'provider',
      rewardStatus: 'reward_status',
      rewardText: 'reward_text',
      rewardNote: 'reward_note',
      rewardCode: 'reward_code',
      plan: 'plan',
      email: 'email',
      observeStartAt: 'observe_start_at',
      observeWindowMs: 'observe_window_ms',
      snapshotPoints: 'snapshot_points',
      snapshotRuleVersion: 'snapshot_rule_version',
      snapshotPriority: 'snapshot_priority',
      pooledAt: 'pooled_at',
    }
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = ?`)
        vals.push((patch as Record<string, unknown>)[k] ?? null)
      }
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    vals.push(Date.now(), id)
    conn.prepare(`UPDATE contributions SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]))
  },

  // 原子状态转移：仅当当前状态在 from 内才改为 to；返回是否改动（防并发重复处理）
  transition(id: string, from: string[], to: string): boolean {
    const ph = from.map(() => '?').join(',')
    const r = conn
      .prepare(
        `UPDATE contributions SET verify_status = ?, updated_at = ?
         WHERE id = ? AND verify_status IN (${ph})`,
      )
      .run(to, Date.now(), id, ...from)
    return r.changes > 0
  },

  // 原子进池：转态为 pooled 与写入 pooled_at（首次进池时刻＝结算资格判据）合并进同一条 UPDATE。单语句
  // ＝天然原子，杜绝「transition 成功、随后 update 未落」的 pooled+NULL 悬号——那种号会被
  // eligibleForSettlement 永久排除，在池计量却永不发分（codex 于 PR #18 复审指出分两句非原子、崩溃即漏发）。
  transitionToPool(id: string, from: string[], ts: number): boolean {
    const ph = from.map(() => '?').join(',')
    const r = conn
      .prepare(
        `UPDATE contributions SET verify_status = 'pooled', pooled_at = ?, updated_at = ?
         WHERE id = ? AND verify_status IN (${ph})`,
      )
      .run(ts, Date.now(), id, ...from)
    return r.changes > 0
  },

  // 条件删除某贡献行——首检失败·退回专用（§2.4/§3.2）：号首检就 401/封号、压根没入池，删行以释放
  // (provider, account_id) 唯一键，让用户修好后可重交。⚠️ 只用于「从未真正入池」的号；已入池号
  // 一辈子锁唯一键、永不删（§2.4「入池后掉号不支持重交」）。
  // CAS 式守卫（codex bot 于 PR #15 指出）：仅当行仍处 from 态才删，返回是否真删——防「过期巡检结果 /
  // 并发实例」把刚转入 pooled 的号误退回（与 transition 同款 compare-and-set 模式）。
  deleteContribution(id: string, from: string[]): boolean {
    const ph = from.map(() => '?').join(',')
    const r = conn
      .prepare(`DELETE FROM contributions WHERE id = ? AND verify_status IN (${ph})`)
      .run(id, ...from)
    return r.changes > 0
  },

  // 排行榜按「累计获得积分」排名（§6，P5-R1）：累计获得 = SUM(正 delta)——发分为正（结算 awardPoints）、
  // 兑换/扣减为负（spendPoints）；花费的负 delta 不进求和 ⇒ 花掉不掉名次。不写死 reason（凡 delta>0 皆算获得，
  // 兼容未来其它发分来源）。username 取该用户任一贡献号（point_ledger 只有 linuxdo_id）、无贡献号空串兜。
  // 没获得过分的不上榜（纯扣减用户 points=0 由 HAVING 排除）。全序＝points DESC, 首次入账 MIN(created_at) ASC,
  // 同刻再按 MIN(id) ASC（point_ledger.id AUTOINCREMENT＝入账序、跨用户严格唯一，故全序无并列、位置确定）。
  // myRank 用**同一全序**数名次，故榜单位置与底部「当前名次」恒一致（codex xhigh P2）。
  leaderboard(limit = 20): { linuxdoId: number; username: string; points: number }[] {
    return conn
      .prepare(
        `SELECT l.linuxdo_id AS linuxdoId,
                COALESCE((SELECT username FROM contributions WHERE linuxdo_id = l.linuxdo_id LIMIT 1), '') AS username,
                SUM(CASE WHEN l.delta > 0 THEN l.delta ELSE 0 END) AS points
         FROM point_ledger l
         GROUP BY l.linuxdo_id
         HAVING points > 0
         ORDER BY points DESC, MIN(l.created_at) ASC, MIN(l.id) ASC
         LIMIT ?`,
      )
      .all(limit) as unknown as { linuxdoId: number; username: string; points: number }[]
  },

  // 我的排名与累计获得积分（用于榜单外也能看到自己的名次）。名次＝与 leaderboard **同一全序**（points DESC,
  // firstAt=MIN(created_at) ASC, firstId=MIN(id) ASC）下排在我前面的人数 +1——故底部「当前名次」与榜单位置恒一致。
  // 修 codex xhigh P2：旧版只数「累计获得严格多于我的人数」，同分被 tie-break 挤出前 20 者会误标名次 1（榜内同分者
  // 却隐含占 1..20 位，自相矛盾）。三键与 leaderboard ORDER BY 逐字对应，且 firstId 跨用户唯一 ⇒ 全序无并列。
  myRank(linuxdoId: number): { rank: number; points: number } {
    const mine = conn
      .prepare(
        `SELECT SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS p,
                MIN(created_at) AS firstAt, MIN(id) AS firstId
         FROM point_ledger WHERE linuxdo_id = ?`,
      )
      .get(linuxdoId) as unknown as { p: number | null; firstAt: number | null; firstId: number | null }
    // SUM 无行时返回 null（无 ledger 行）→ ?? 0；全负 delta 时 CASE 逐行取 0、SUM=0（非 null）。没获得过分不排名。
    const points = mine?.p ?? 0
    if (points === 0) return { rank: 0, points: 0 }
    // 排在我前面的人数（同全序三键）：p 更高，或 p 相同但首次入账更早（firstAt 更小，或同刻 firstId 更小）。
    // points>0 ⇒ 我有 ledger 行 ⇒ firstAt/firstId 非空。参数依序：myP, myP, myFirstAt, myFirstAt, myFirstId。
    const ahead = conn
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT linuxdo_id, SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS p,
                  MIN(created_at) AS firstAt, MIN(id) AS firstId
           FROM point_ledger GROUP BY linuxdo_id HAVING p > 0
         ) WHERE p > ? OR (p = ? AND (firstAt < ? OR (firstAt = ? AND firstId < ?)))`,
      )
      .get(points, points, mine!.firstAt, mine!.firstAt, mine!.firstId) as unknown as { n: number }
    return { rank: (ahead?.n ?? 0) + 1, points }
  },

  // ===== 配置：全局键值（app_config）=====
  getConfig(key: string): string | null {
    const r = conn.prepare('SELECT value FROM app_config WHERE key=?').get(key) as unknown as
      | { value: string }
      | undefined
    return r?.value ?? null
  },
  setConfig(key: string, value: string): void {
    conn
      .prepare(
        `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(key, value, Date.now())
  },

  // ===== 配置：信任等级门槛 & 限身份开关（P4-R2，§1）=====
  // 两控件：门槛数值 min_trust_level + 是否启用门槛 trust_gate_enabled（关＝登录即可、不限信任等级）。
  // 门槛只在登录回调判（callback route），调整不影响已登录会话（保留至过期）。
  getMinTrustLevel(): number {
    // 缺省回落 env.linuxdo.minTrustLevel（保留 ENV MIN_TRUST_LEVEL 作向后兼容默认）；脏值/负值同回落。
    const raw = db.getConfig('min_trust_level')
    if (raw == null) return env.linuxdo.minTrustLevel
    const n = Math.floor(Number(raw))
    return Number.isFinite(n) && n >= 0 ? n : env.linuxdo.minTrustLevel
  },
  setMinTrustLevel(n: number): void {
    db.setConfig('min_trust_level', String(Math.max(0, Math.floor(Number(n) || 0))))
  },
  // 是否启用信任门槛：缺省 true（仅显式 '0' 才关＝登录即可、不限等级）。
  isTrustGateEnabled(): boolean {
    return db.getConfig('trust_gate_enabled') !== '0'
  },
  setTrustGateEnabled(on: boolean): void {
    db.setConfig('trust_gate_enabled', on ? '1' : '0')
  },

  // ===== 配置：结算参数（结算时刻，P4-R2，§3.3）=====
  // 结算时刻＝午夜后延迟分钟数（日切延迟）：settle_grace_minutes × 60000，缺省 10 分钟、钳 [0,1439]（一天内）。
  // 时区随服务器不可配（§3.3 明确）。lib/settle.ts 每轮读，缺省仍 10min ⇒ 现有 daily-settlement 测试不破。
  getSettleGraceMs(): number {
    const raw = db.getConfig('settle_grace_minutes')
    if (raw == null) return 10 * 60_000
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n) || n < 0) return 10 * 60_000 // 脏值/负值回落缺省
    return Math.min(1439, n) * 60_000 // 上钳 1439 分钟（一天内）
  },
  setSettleGraceMinutes(n: number): void {
    db.setConfig('settle_grace_minutes', String(Math.max(0, Math.min(1439, Math.floor(Number(n) || 0)))))
  },

  // ===== 配置：入池优先级（§2.5/§7.1）=====
  // 贡献号入池即设的全局优先级（cpamp 数字越大越优先），缺省 10、后台可调。存 app_config['pool_priority']。
  // 取值钳非负整数（脏值/缺失一律回落缺省，getPoolPriority 侧也防一道——即便绕 setter 直写脏值判定仍安全）。
  getPoolPriority(): number {
    const raw = db.getConfig(POOL_PRIORITY_KEY)
    if (raw == null) return POOL_PRIORITY_DEFAULT
    const n = Math.floor(Number(raw))
    return Number.isFinite(n) && n >= 0 ? n : POOL_PRIORITY_DEFAULT
  },
  setPoolPriority(n: number): void {
    db.setConfig(POOL_PRIORITY_KEY, String(Math.max(0, Math.floor(Number(n) || 0))))
  },

  // ===== 配置：发分规则 =====
  listPointRules(): PointRule[] {
    return conn
      .prepare('SELECT id, provider, plan, points, enabled, label FROM point_rules ORDER BY provider, points DESC')
      .all() as unknown as PointRule[]
  },
  // (provider, plan) 应发多少分：先精确匹配，再 provider 兜底(*)，都没有=0(不接受)
  pointsFor(provider: string, plan: string): number {
    const p = provider.toLowerCase()
    const pl = (plan || '').toLowerCase()
    const exact = conn
      .prepare('SELECT points FROM point_rules WHERE provider=? AND plan=? AND enabled=1')
      .get(p, pl) as unknown as { points: number } | undefined
    if (exact) return exact.points
    const wild = conn
      .prepare("SELECT points FROM point_rules WHERE provider=? AND plan='*' AND enabled=1")
      .get(p) as unknown as { points: number } | undefined
    return wild?.points ?? 0
  },
  upsertPointRule(r: { id?: number; provider: string; plan: string; points: number; enabled: boolean; label: string }): void {
    conn
      .prepare(
        `INSERT INTO point_rules (provider, plan, points, enabled, label) VALUES (?,?,?,?,?)
         ON CONFLICT(provider, plan) DO UPDATE SET points=excluded.points, enabled=excluded.enabled, label=excluded.label`,
      )
      .run(r.provider.toLowerCase(), r.plan.toLowerCase(), r.points, r.enabled ? 1 : 0, r.label)
  },
  deletePointRule(id: number): boolean {
    return conn.prepare('DELETE FROM point_rules WHERE id=?').run(id).changes === 1
  },

  // ===== 配置：兑换项 =====
  listRedeemItems(onlyEnabled = false): RedeemItem[] {
    const sql = `SELECT id, name, description, cost, kind, enabled, sort, config, fulfillment,
        per_user_limit AS perUserLimit FROM redeem_items ${
      onlyEnabled ? 'WHERE enabled=1' : ''
    } ORDER BY sort, cost`
    return conn.prepare(sql).all() as unknown as RedeemItem[]
  },
  getRedeemItem(id: number): RedeemItem | undefined {
    return conn
      .prepare(
        `SELECT id, name, description, cost, kind, enabled, sort, config, fulfillment,
         per_user_limit AS perUserLimit FROM redeem_items WHERE id=?`,
      )
      .get(id) as unknown as RedeemItem | undefined
  },
  // fulfillment/perUserLimit 可选：未传时 UPDATE 用 COALESCE 保留原值（既有「只改名/价」的 PUT 不误清），
  // INSERT 落库时用默认（placeholder / 0）。
  upsertRedeemItem(it: {
    id?: number
    name: string
    description: string
    cost: number
    kind: string
    enabled: boolean
    sort: number
    config?: string
    fulfillment?: string
    perUserLimit?: number
  }): number | undefined {
    if (it.id) {
      const result = conn
        .prepare(
          `UPDATE redeem_items SET name=?, description=?, cost=?, kind=?, enabled=?, sort=?, config=?,
             fulfillment=COALESCE(?, fulfillment), per_user_limit=COALESCE(?, per_user_limit) WHERE id=?`,
        )
        .run(
          it.name, it.description, it.cost, it.kind, it.enabled ? 1 : 0, it.sort, it.config ?? '{}',
          it.fulfillment ?? null, it.perUserLimit ?? null, it.id,
        )
      return result.changes === 1 ? it.id : undefined
    } else {
      const result = conn
        .prepare(
          `INSERT INTO redeem_items (name, description, cost, kind, enabled, sort, config, fulfillment, per_user_limit)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          it.name, it.description, it.cost, it.kind, it.enabled ? 1 : 0, it.sort, it.config ?? '{}',
          it.fulfillment ?? 'placeholder', it.perUserLimit ?? 0,
        )
      return Number(result.lastInsertRowid)
    }
  },
  getRedeemItemCreateRequest(requestKey: string): RedeemItemCreateRequest | undefined {
    return conn
      .prepare(
        `SELECT request_key AS requestKey, payload_hash AS payloadHash, item_id AS itemId,
                created_at AS createdAt
         FROM redeem_item_create_requests WHERE request_key=?`,
      )
      .get(requestKey) as unknown as RedeemItemCreateRequest | undefined
  },
  recordRedeemItemCreateRequest(request: RedeemItemCreateRequest): void {
    conn.prepare(
      `INSERT INTO redeem_item_create_requests (request_key, payload_hash, item_id, created_at)
       VALUES (?,?,?,?)`,
    ).run(request.requestKey, request.payloadHash, request.itemId, request.createdAt)
  },
  deleteRedeemItem(id: number): boolean {
    return conn.prepare('DELETE FROM redeem_items WHERE id=?').run(id).changes === 1
  },

  // ===== 积分：发放/消耗/余额 =====
  // 幂等发分：同一 (reason, ref) 只入账一次。返回是否本次真正入账
  awardPoints(linuxdoId: number, delta: number, reason: string, ref: string): boolean {
    if (delta === 0) return false
    const r = conn
      .prepare(
        `INSERT INTO point_ledger (linuxdo_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(reason, ref) DO NOTHING`,
      )
      .run(linuxdoId, delta, reason, ref, Date.now())
    return r.changes > 0
  },
  balance(linuxdoId: number): number {
    const r = conn
      .prepare('SELECT COALESCE(SUM(delta),0) AS bal FROM point_ledger WHERE linuxdo_id=?')
      .get(linuxdoId) as unknown as { bal: number }
    return r?.bal ?? 0
  },
  // 原子消耗：仅当余额 >= cost 才扣。返回是否成功
  spendPoints(linuxdoId: number, cost: number, reason: string, ref: string): boolean {
    const r = conn
      .prepare(
        `INSERT INTO point_ledger (linuxdo_id, delta, reason, ref, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COALESCE(SUM(delta),0) FROM point_ledger WHERE linuxdo_id=?) >= ?`,
      )
      .run(linuxdoId, -Math.abs(cost), reason, ref, Date.now(), linuxdoId, cost)
    return r.changes > 0
  },

  // 某用户积分明细（P2-R3，§6）：point_ledger 每笔加/扣，按时间倒序（最近在前）。展示侧由
  // describeLedgerEntry 把 reason='usage' 的裸 ref 转人话；limit 防明细无限增长拖慢 dashboard。
  ledgerFor(linuxdoId: number, limit = 50): LedgerEntry[] {
    return conn
      .prepare(
        `SELECT id, delta, reason, ref, created_at AS createdAt FROM point_ledger
         WHERE linuxdo_id=? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(linuxdoId, limit) as unknown as LedgerEntry[]
  },

  // ===== 用量折算 + 按日结算（P2-R2）=====
  // (provider, plan) 每次调用积分单价：先精确 (provider, plan)、再 provider 兜底 plan='*'、都没有=0。
  // 仿 pointsFor 风格；单价可为小数（usage_rates.points_per_call REAL），折算 = round(次数 × 单价) 由调用方做。
  ratePerCall(provider: string, plan: string): number {
    const p = provider.toLowerCase()
    const pl = (plan || '').toLowerCase()
    const exact = conn
      .prepare('SELECT points_per_call FROM usage_rates WHERE provider=? AND plan=? AND enabled=1')
      .get(p, pl) as unknown as { points_per_call: number } | undefined
    if (exact) return exact.points_per_call
    const wild = conn
      .prepare("SELECT points_per_call FROM usage_rates WHERE provider=? AND plan='*' AND enabled=1")
      .get(p) as unknown as { points_per_call: number } | undefined
    return wild?.points_per_call ?? 0
  },

  // ===== 配置：折算规则 usage_rates（P4-R2，§3.4）=====
  // 仿 point_rules CRUD，唯一差异：列名 points_per_call（REAL、可小数），字段名 pointsPerCall。ratePerCall（上）为读取器。
  listUsageRates(): UsageRate[] {
    return conn
      .prepare('SELECT id, provider, plan, points_per_call AS pointsPerCall, enabled, label FROM usage_rates ORDER BY provider, points_per_call DESC')
      .all() as unknown as UsageRate[]
  },
  upsertUsageRate(r: { id?: number; provider: string; plan: string; pointsPerCall: number; enabled: boolean; label: string }): void {
    conn
      .prepare(
        `INSERT INTO usage_rates (provider, plan, points_per_call, enabled, label) VALUES (?,?,?,?,?)
         ON CONFLICT(provider, plan) DO UPDATE SET points_per_call=excluded.points_per_call, enabled=excluded.enabled, label=excluded.label`,
      )
      .run(r.provider.toLowerCase(), r.plan.toLowerCase(), r.pointsPerCall, r.enabled ? 1 : 0, r.label)
  },
  deleteUsageRate(id: number): boolean {
    return conn.prepare('DELETE FROM usage_rates WHERE id=?').run(id).changes === 1
  },

  // 直接写入一条结算水位的低层 helper，保留给测试夹具和只读展示准备；生产结算路径必须走
  // reconcileUsageSettlement，才能在同一事务内原子追加正 delta ledger 并推进累计水位。
  recordSettlement(rec: {
    contributionId: string
    date: string
    provider: string
    accountId: string
    callCount: number
    points: number
  }): boolean {
    const r = conn
      .prepare(
        `INSERT INTO daily_settlements
           (contribution_id, date, provider, account_id, call_count, points, settled_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(contribution_id, date) DO NOTHING`,
      )
      .run(rec.contributionId, rec.date, rec.provider, rec.accountId, rec.callCount, rec.points, Date.now())
    return r.changes > 0
  },

  // 查询该号该日是否已有累计水位。仅供检查；不能据此跳过 reconciliation，否则迟到用量会永久漏发。
  hasSettled(contributionId: string, date: string): boolean {
    return !!conn
      .prepare('SELECT 1 FROM daily_settlements WHERE contribution_id=? AND date=? LIMIT 1')
      .get(contributionId, date)
  },

  // daily_settlements 的唯一行是该号该日的单调累计水位。BEGIN IMMEDIATE 在读取旧值前取写锁，
  // 跨进程相同快照会串行看到最新水位；正 delta ledger 与水位 INSERT/UPDATE 同成同败。
  reconcileUsageSettlement(rec: {
    contributionId: string
    date: string
    provider: string
    accountId: string
    plan: string
    callCount: number
    linuxdoId: number
  }): {
    status: 'created' | 'advanced' | 'unchanged' | 'regressed' | 'invalid'
    settled: boolean
    awarded: boolean
    rate?: number
    previousCallCount?: number
  } {
    if (!Number.isSafeInteger(rec.callCount) || rec.callCount < 0) {
      throw new Error('invalid daily usage count')
    }
    conn.exec('BEGIN IMMEDIATE')
    try {
      const existing = conn
        .prepare(
          `SELECT id, contribution_id, date, provider, account_id, call_count, points, settled_at
           FROM daily_settlements WHERE contribution_id=? AND date=?`,
        )
        .get(rec.contributionId, rec.date) as unknown as DsRow | undefined

      if (existing) {
        if (existing.provider !== rec.provider || existing.account_id !== rec.accountId) {
          throw new Error('usage settlement identity mismatch')
        }
        if (!Number.isSafeInteger(existing.call_count) || existing.call_count < 0 ||
            !Number.isSafeInteger(existing.points) || existing.points < 0) {
          throw new Error('invalid stored usage settlement watermark')
        }
        if (rec.callCount < existing.call_count) {
          conn.exec('COMMIT')
          return {
            status: 'regressed',
            settled: false,
            awarded: false,
            previousCallCount: existing.call_count,
          }
        }
        if (rec.callCount === existing.call_count) {
          conn.exec('COMMIT')
          return { status: 'unchanged', settled: false, awarded: false }
        }
      }

      const oldCount = existing?.call_count ?? 0
      const countDelta = rec.callCount - oldCount
      const rate = db.ratePerCall(rec.provider, rec.plan)
      const pointsDelta = Math.round(countDelta * rate)
      const nextPoints = (existing?.points ?? 0) + pointsDelta
      if (!Number.isFinite(rate) || rate < 0 ||
          !Number.isSafeInteger(pointsDelta) || pointsDelta < 0 ||
          !Number.isSafeInteger(nextPoints) || nextPoints < 0) {
        conn.exec('COMMIT')
        return { status: 'invalid', settled: false, awarded: false, rate }
      }

      if (pointsDelta > 0) {
        const ref = existing
          ? `usage:${rec.contributionId}:${rec.date}:calls:${rec.callCount}`
          : `usage:${rec.contributionId}:${rec.date}`
        conn
          .prepare('INSERT INTO point_ledger (linuxdo_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)')
          .run(rec.linuxdoId, pointsDelta, 'usage', ref, Date.now())
      }

      if (existing) {
        const updated = conn
          .prepare(
            `UPDATE daily_settlements SET call_count=?, points=?, settled_at=?
             WHERE id=? AND call_count=? AND points=?`,
          )
          .run(rec.callCount, nextPoints, Date.now(), existing.id, existing.call_count, existing.points)
        if (updated.changes !== 1) throw new Error('usage settlement watermark update conflict')
      } else {
        conn
          .prepare(
            `INSERT INTO daily_settlements
               (contribution_id, date, provider, account_id, call_count, points, settled_at)
             VALUES (?,?,?,?,?,?,?)`,
          )
          .run(
            rec.contributionId,
            rec.date,
            rec.provider,
            rec.accountId,
            rec.callCount,
            nextPoints,
            Date.now(),
          )
      }
      conn.exec('COMMIT')
      return {
        status: existing ? 'advanced' : 'created',
        settled: true,
        awarded: pointsDelta > 0,
      }
    } catch (err) {
      conn.exec('ROLLBACK')
      throw err
    }
  },

  // 某号全部按日结算记录（供 R3 展示累计），按自然日升序、同日以自增 id 兜底稳序
  settlementsFor(contributionId: string): DailySettlement[] {
    return (
      conn
        .prepare(
          `SELECT id, contribution_id, date, provider, account_id, call_count, points, settled_at
           FROM daily_settlements WHERE contribution_id=? ORDER BY date ASC, id ASC`,
        )
        .all(contributionId) as unknown as DsRow[]
    ).map(toDailySettlement)
  },

  // 某号累计积分（P2-R3，§4/§6）＝该号全部按日结算 points 之和。v4 积分不再挂在 contributions.points
  // 列（那列 v4 恒 0），号主靠这个号累计赚的分一律由 daily_settlements 汇总——dashboard 每号一行据此显示。
  contributionPoints(contributionId: string): number {
    const r = conn
      .prepare('SELECT COALESCE(SUM(points),0) AS pts FROM daily_settlements WHERE contribution_id=?')
      .get(contributionId) as unknown as { pts: number }
    return r?.pts ?? 0
  },

  // ===== 兑换记录 =====
  createRedemption(rec: {
    id: string
    linuxdoId: number
    itemId: number
    itemName: string
    cost: number
    status: string
    result?: string
  }): void {
    conn
      .prepare(
        'INSERT INTO redemptions (id, linuxdo_id, item_id, item_name, cost, status, result, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(rec.id, rec.linuxdoId, rec.itemId, rec.itemName, rec.cost, rec.status, rec.result ?? '', Date.now())
  },
  updateRedemption(id: string, patch: { status?: string; result?: string }): void {
    const sets: string[] = []
    const vals: unknown[] = []
    if (patch.status !== undefined) { sets.push('status=?'); vals.push(patch.status) }
    if (patch.result !== undefined) { sets.push('result=?'); vals.push(patch.result) }
    if (!sets.length) return
    vals.push(id)
    conn.prepare(`UPDATE redemptions SET ${sets.join(', ')} WHERE id=?`).run(...(vals as never[]))
  },
  listRedemptions(linuxdoId: number): RedemptionRow[] {
    return conn
      .prepare(
        'SELECT id, item_name AS itemName, cost, status, result, created_at AS createdAt FROM redemptions WHERE linuxdo_id=? ORDER BY created_at DESC',
      )
      .all(linuxdoId) as unknown as RedemptionRow[]
  },

  // ===== CDK 发码库存（P3-R1，§5.3）=====
  // 批量导入 available 码，去重：同一 (item_id, code) 已存 → 跳过（依赖 UNIQUE(item_id, code) 原子去重）；
  // 入参批次内重复也只算一次（seen 兜）。返回 { imported 本次真正入库数, skipped 跳过数 }。
  // ⚠️ 安全（§8）：绝不日志 code；调用链任何环节不得把 code 写进应用日志。
  importCdkCodes(
    itemId: number,
    codes: string[],
    faceValue: number | null = null,
  ): { imported: number; skipped: number } {
    const now = Date.now()
    // 批级面额（P3-R2）：一批同面额。LDC 商品的码带正整数面额（每日额度判定用）；非 LDC 传 null（面额恒空、
    // 不受额度约束）。面额策略（LDC 必带、非 LDC 恒 null）由 admin CDK 导入 API 按 item.kind 定，此处只落库取整。
    const fv = faceValue == null ? null : Math.floor(faceValue)
    const stmt = conn.prepare(
      `INSERT INTO cdk_codes (item_id, code, status, face_value, created_at) VALUES (?,?,'available',?,?)
       ON CONFLICT(item_id, code) DO NOTHING`,
    )
    let imported = 0
    let skipped = 0
    const seen = new Set<string>()
    for (const code of codes) {
      if (seen.has(code)) {
        skipped++
        continue
      }
      seen.add(code)
      const r = stmt.run(itemId, code, fv, now)
      if (r.changes > 0) imported++
      else skipped++
    }
    return { imported, skipped }
  },
  // 某项可用码数（store 售罄提示 + 测试用）。不返回任何 code 值。
  availableCdkCount(itemId: number): number {
    const r = conn
      .prepare("SELECT COUNT(*) AS n FROM cdk_codes WHERE item_id=? AND status='available'")
      .get(itemId) as unknown as { n: number }
    return r?.n ?? 0
  },
  // 某项库存分布（available/issued/void 计数，管理/测试用）。不返回任何 code 值。
  cdkStatsFor(itemId: number): { available: number; issued: number; void: number } {
    const rows = conn
      .prepare("SELECT status, COUNT(*) AS n FROM cdk_codes WHERE item_id=? GROUP BY status")
      .all(itemId) as unknown as { status: string; n: number }[]
    const out: { available: number; issued: number; void: number } = { available: 0, issued: 0, void: 0 }
    for (const r of rows) if (r.status in out) (out as Record<string, number>)[r.status] = r.n
    return out
  },

  // ===== LDC 每日限量（P3-R2，§8）=====
  // 每日额度：app_config['ldc_daily_quota']，缺省 2000。取值钳非负整数（脏值/缺失一律回落缺省，
  // getLdcQuota 侧也防一道——即便有人绕过 setLdcQuota 直写脏值，判定仍安全）。
  getLdcQuota(): number {
    const raw = db.getConfig(LDC_DAILY_QUOTA_KEY)
    if (raw == null) return LDC_DAILY_QUOTA_DEFAULT
    const n = Math.floor(Number(raw))
    return Number.isFinite(n) && n >= 0 ? n : LDC_DAILY_QUOTA_DEFAULT
  },
  setLdcQuota(quota: number): void {
    db.setConfig(LDC_DAILY_QUOTA_KEY, String(Math.max(0, Math.floor(Number(quota) || 0))))
  },
  // 今日（服务器本地自然日）已发 LDC 面额之和：**全局**（限的是 LDC 币每日流出总量，非单商品）。
  // 判据＝cdk_codes.status='issued' 且 issued_at 落在今日 且 face_value 非空——**face_value 非空本身即
  // 「LDC 面额码」的自足标志**（导入口强制：LDC 商品必带正整数面额、非 LDC 恒 null），故不 JOIN 商品表、
  // 不看当前 kind：否则当日发码后改商品 kind / 删商品会让已发码退出统计＝额度被重新释放、可超发
  // （codex 于 PR #20 复审指出）。now 注入以可测；与 performRedeem 同一 conn，事务内调用读得到本次占码。
  ldcIssuedToday(now: number): number {
    const { start, end } = localDayBounds(now)
    const r = conn
      .prepare(
        `SELECT COALESCE(SUM(face_value), 0) AS total
         FROM cdk_codes
         WHERE status='issued' AND issued_at >= ? AND issued_at < ? AND face_value IS NOT NULL`,
      )
      .get(start, end) as unknown as { total: number }
    return r?.total ?? 0
  },
  // store 展示用「今日已抢完」布尔（§8 只回布尔、不外泄剩余额度精确值）：该项有可用码但今日 LDC 额度已不够
  // 发它下一张待发码（issuedToday + 下一张面额 > 额度）。无可用码 / 下一张码无面额 → false（前者是普通
  // 「已兑罄」另一路判，后者不受额度约束）。真正的拦截在 performRedeem 事务内，此处仅前端提示、非权威。
  ldcExhaustedToday(itemId: number, now: number): boolean {
    const next = conn
      .prepare("SELECT face_value FROM cdk_codes WHERE item_id=? AND status='available' ORDER BY id LIMIT 1")
      .get(itemId) as unknown as { face_value: number | null } | undefined
    if (!next || next.face_value == null) return false
    return db.ldcIssuedToday(now) + next.face_value > db.getLdcQuota()
  },

  // 兑换单事务（P3-R1，§5.5「同成功或同失败」）：单 BEGIN IMMEDIATE 包住
  //   ① 幂等回放 → ② 查限购 → ③ CAS 占码 → ④ 扣分 → ⑤ 写兑换记录（回填码归属由占码那步一并完成）。
  // 任一步不满足/失败 → 整体 ROLLBACK、绝不扣分。顺带修两个既有 bug：
  //   bug①：旧版 spendPoints 与 createRedemption 非同事务（扣分成功但写记录抛错＝分丢无记录）——本事务同成同败。
  //   bug②：redemptionId 改为**确定性幂等键**（调用方按 token/短窗算），既作 redemptions 主键又作
  //         point_ledger 的 ref——重复点击/超时重试命中已存兑换即回放同一结果，UNIQUE(reason,ref) 兜第二道。
  // 占码用 CAS（SELECT 一条 available → UPDATE ... WHERE id=? AND status='available'，仿 transition 范式）：
  //   单机单 worker + BEGIN IMMEDIATE 已串行，CAS 为纪律与未来多实例兜底，保证并发不重复发同一码。
  // 返回 result：cdk 类＝占用的码；placeholder 类＝调用方给的占位串。replay＝是否命中幂等回放。
  performRedeem(args: {
    linuxdoId: number
    redemptionId: string
    item: RedeemItem
    placeholderResult: string
    now?: number // 注入以可测（issued_at 落库时刻 + LDC 当日额度边界）；生产不传＝真实时钟
  }): { ok: true; result: string; balance: number; replay: boolean } | { ok: false; error: string } {
    const { linuxdoId, redemptionId, item } = args
    const isCdk = item.fulfillment === 'cdk'
    const now = args.now ?? Date.now()
    conn.exec('BEGIN IMMEDIATE')
    try {
      // ① 幂等回放：同一 redemptionId 已兑过 → 返回原结果，不再占码/扣分（重复点击 / 超时重试兜底）
      const existing = conn
        .prepare('SELECT result FROM redemptions WHERE id=?')
        .get(redemptionId) as unknown as { result: string } | undefined
      if (existing) {
        conn.exec('COMMIT')
        return { ok: true, result: existing.result, balance: db.balance(linuxdoId), replay: true }
      }

      // ② 限购：本人对该项已成功兑换数 >= 上限（>0 才限）→ 拦截、不扣分
      if (item.perUserLimit > 0) {
        const c = conn
          .prepare(
            "SELECT COUNT(*) AS n FROM redemptions WHERE linuxdo_id=? AND item_id=? AND status='fulfilled'",
          )
          .get(linuxdoId, item.id) as unknown as { n: number }
        if ((c?.n ?? 0) >= item.perUserLimit) {
          conn.exec('ROLLBACK')
          return { ok: false, error: '超过限购' }
        }
      }

      // ③ 占库存（cdk 类）：CAS 占一个 available 码 → 无则已兑罄、不扣分。占码即回填 issued_to/redemption_id/issued_at
      let result = args.placeholderResult
      if (isCdk) {
        const row = conn
          .prepare("SELECT id, code, face_value FROM cdk_codes WHERE item_id=? AND status='available' ORDER BY id LIMIT 1")
          .get(item.id) as unknown as { id: number; code: string; face_value: number | null } | undefined
        if (!row) {
          conn.exec('ROLLBACK')
          return { ok: false, error: '已兑罄' }
        }
        const claimed = conn
          .prepare(
            "UPDATE cdk_codes SET status='issued', issued_to=?, redemption_id=?, issued_at=? WHERE id=? AND status='available'",
          )
          .run(linuxdoId, redemptionId, now, row.id)
        if (claimed.changes === 0) {
          // CAS 落空（该码已被并发占）——单机不该发生，兜底当已兑罄回滚
          conn.exec('ROLLBACK')
          return { ok: false, error: '已兑罄' }
        }
        result = row.code

        // ③.5 LDC 每日限量（P3-R2，§2）：本码已占（issued_at=now），故已计入「今日已发面额之和」。
        //   **面额驱动、与展示分类解耦**（§5.2 kind 只是展示分类；codex 于 PR #20 复审指出按 kind 判可被
        //   「发码后改 kind」绕过或释放额度）：凡占到**带面额**的码一律受全局每日额度约束——含本码的当日
        //   已发面额之和 > 额度 → 整体 ROLLBACK、「今日已抢完」、不扣分（占码随事务回滚复原）。边界 ≤：
        //   恰好等于额度可发（严格 > 才拦）。幂等回放在①已 return，同 token 重放天然不双计额度。
        //   判定与统计（ldcIssuedToday）同口径同事务＝并发下绝不超额。
        if (row.face_value != null) {
          if (db.ldcIssuedToday(now) > db.getLdcQuota()) {
            conn.exec('ROLLBACK')
            return { ok: false, error: '今日已抢完' }
          }
        } else if (item.kind === 'ldc') {
          // LDC 商品占到**无面额**码＝配置异常——只能来自「先给非 LDC 商品导码、后改 kind='ldc'」的错序
          // 操作（导入口对 LDC 强制正整数面额）。发出既绕过每日额度、用户又拿到无面额的废码——宁拦不发
          // （codex 于 PR #20 复审 P1）。管理员补救：作废该批无面额码、按面额重导。
          conn.exec('ROLLBACK')
          return { ok: false, error: '商品配置异常，暂不可兑' }
        }
      }

      // ④ 扣分：原子（余额 < cost 直接不入账），ref=redemptionId＝幂等键。失败＝积分不足、整体回滚
      const spent = db.spendPoints(linuxdoId, item.cost, 'redeem', redemptionId)
      if (!spent) {
        conn.exec('ROLLBACK')
        return { ok: false, error: '积分不足' }
      }

      // ⑤ 写兑换记录（主键=redemptionId＝幂等键）：result 存发出的码（cdk）或占位串（placeholder）
      db.createRedemption({
        id: redemptionId,
        linuxdoId,
        itemId: item.id,
        itemName: item.name,
        cost: item.cost,
        status: 'fulfilled',
        result,
      })

      conn.exec('COMMIT')
      return { ok: true, result, balance: db.balance(linuxdoId), replay: false }
    } catch (err) {
      conn.exec('ROLLBACK')
      throw err
    }
  },

  // ===== OAuth 会话与 provider 级租约（migration 014）=====
  // 单条 UPSERT 原子抢占：有效租约存在时不覆盖；仅 expires_at <= now 的旧租约可被新 fencing token
  // 替换。同 provider 串行、不同 provider 的主键不同，可独立推进。所有 await 都在调用方事务外。
  acquireOAuthProviderLease(lease: OAuthProviderLease): boolean {
    if (!lease.provider || !lease.leaseToken || lease.expiresAt <= lease.now) return false
    const result = conn
      .prepare(
        `INSERT INTO oauth_provider_leases
           (provider, lease_token, linuxdo_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           lease_token=excluded.lease_token,
           linuxdo_id=excluded.linuxdo_id,
           created_at=excluded.created_at,
           expires_at=excluded.expires_at
         WHERE oauth_provider_leases.expires_at <= excluded.created_at`,
      )
      .run(lease.provider, lease.leaseToken, lease.linuxdoId, lease.now, lease.expiresAt)
    return result.changes === 1
  },

  // 只按 provider + fencing token 释放。过期的旧请求即使晚到，也删不掉后来者的新租约。
  releaseOAuthProviderLease(provider: string, leaseToken: string): boolean {
    return conn
      .prepare('DELETE FROM oauth_provider_leases WHERE provider=? AND lease_token=?')
      .run(provider, leaseToken).changes === 1
  },

  // CPA start 返回 state 后才落会话。短事务内重新核验租约仍属于发起者且未过期，再 INSERT；
  // state 冲突不覆盖旧会话，返回 false 让调用方释放自己的租约并 fail closed。
  createOAuthSession(session: OAuthSessionCreate): boolean {
    if (
      !session.state ||
      !session.authorizationUrl ||
      session.expiresAt <= session.createdAt ||
      session.hardExpiresAt < session.expiresAt ||
      session.hardExpiresAt <= session.createdAt
    ) return false
    conn.exec('BEGIN IMMEDIATE')
    try {
      const lease = conn
        .prepare(
          `SELECT 1 FROM oauth_provider_leases
           WHERE provider=? AND lease_token=? AND linuxdo_id=? AND expires_at>?`,
        )
        .get(session.provider, session.leaseToken, session.linuxdoId, session.createdAt)
      if (!lease) {
        conn.exec('COMMIT')
        return false
      }
      const extended = conn
        .prepare(
          `UPDATE oauth_provider_leases
           SET expires_at=?
           WHERE provider=? AND lease_token=? AND linuxdo_id=? AND expires_at>?`,
        )
        .run(
          session.hardExpiresAt,
          session.provider,
          session.leaseToken,
          session.linuxdoId,
          session.createdAt,
        )
      if (extended.changes !== 1) {
        conn.exec('ROLLBACK')
        return false
      }
      const inserted = conn
        .prepare(
          `INSERT OR IGNORE INTO oauth_snapshots
           (state, file_names, created_at, linuxdo_id, provider, expires_at, lease_token,
            operation_token, operation_expires_at, authorization_url, flow, user_code,
            status, hard_expires_at, cancelled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'ACTIVE', ?, NULL)`,
        )
        .run(
          session.state,
          JSON.stringify(session.fileNames),
          session.createdAt,
          session.linuxdoId,
          session.provider,
          session.expiresAt,
          session.leaseToken,
          session.authorizationUrl,
          session.flow,
          session.userCode ?? null,
          session.hardExpiresAt,
        )
      conn.exec('COMMIT')
      return inserted.changes === 1
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  // 刷新/切换页面时只恢复本人、同 provider、尚可观察且租约匹配的会话；绝不返回 fencing token。
  recoverOAuthSession(linuxdoId: number, provider: string, now: number): OAuthSessionRecovery | null {
    const row = conn
      .prepare(
        `SELECT s.state, s.authorization_url, s.flow, s.user_code, s.expires_at
         FROM oauth_snapshots s
         JOIN oauth_provider_leases l
           ON l.provider=s.provider
          AND l.lease_token=s.lease_token
          AND l.linuxdo_id=s.linuxdo_id
         WHERE s.linuxdo_id=? AND s.provider=?
           AND s.status IN ('ACTIVE', 'CLAIMED', 'FINALIZING')
           AND s.expires_at>? AND s.hard_expires_at>? AND l.expires_at>?
         ORDER BY s.created_at DESC
         LIMIT 1`,
      )
      .get(linuxdoId, provider, now, now, now) as unknown as
      | {
          state: string
          authorization_url: string
          flow: string
          user_code: string | null
          expires_at: number
        }
      | undefined
    if (
      !row ||
      !row.state ||
      !row.authorization_url ||
      (row.flow !== 'redirect' && row.flow !== 'device')
    ) return null
    return {
      provider,
      state: row.state,
      url: row.authorization_url,
      flow: row.flow,
      userCode: row.user_code ?? undefined,
      expiresAt: row.expires_at,
    }
  },

  // 诊断/测试只读：不参与安全判定。安全消费必须走 claimOAuthSession 的 user/provider/lease 校验。
  getOAuthSnapshot(state: string): string[] | null {
    const r = conn.prepare('SELECT file_names FROM oauth_snapshots WHERE state=?').get(state) as unknown as
      | { file_names: string }
      | undefined
    if (!r) return null
    try {
      return JSON.parse(r.file_names) as string[]
    } catch {
      return null
    }
  },

  // finish/check 进入 CPA 前的短 operation claim。JOIN 同时核验 snapshot 与 provider lease：
  // user/provider/state/expiry/lease 任一不匹配（含 migration 014 前的 NULL legacy 行）均 invalid；
  // 尚未过期的 operation_token 表示同一 state 正在被另一个请求消费，返回 busy 而不触 CPA。
  claimOAuthSession(input: {
    state: string
    provider: string
    linuxdoId: number
    operationToken: string
    now: number
    operationExpiresAt: number
  }): OAuthSessionClaim {
    if (!input.state || !input.operationToken || input.operationExpiresAt <= input.now) {
      return { status: 'invalid' }
    }
    conn.exec('BEGIN IMMEDIATE')
    try {
      const row = conn
        .prepare(
          `SELECT s.file_names, s.lease_token, s.status, s.expires_at, s.hard_expires_at,
                  s.operation_expires_at, l.lease_token AS active_lease_token
           FROM oauth_snapshots s
           LEFT JOIN oauth_provider_leases l
             ON l.provider=s.provider
            AND l.lease_token=s.lease_token
            AND l.linuxdo_id=s.linuxdo_id
            AND l.expires_at>?
           WHERE s.state=?
             AND s.provider=?
             AND s.linuxdo_id=?
             AND s.hard_expires_at>?
             AND s.lease_token IS NOT NULL`,
        )
        .get(
          input.now,
          input.state,
          input.provider,
          input.linuxdoId,
          input.now,
        ) as unknown as
        | {
            file_names: string
            lease_token: string
            status: string
            expires_at: number
            hard_expires_at: number
            operation_expires_at: number | null
            active_lease_token: string | null
          }
        | undefined
      if (!row) {
        conn.exec('COMMIT')
        return { status: 'invalid' }
      }
      if (
        row.status === 'CANCELLED' ||
        row.status === 'CANCEL_PENDING' ||
        row.status === 'CANCEL_CONFIRMED'
      ) {
        conn.exec('COMMIT')
        return { status: 'cancelled' }
      }
      if (
        (row.status === 'CLAIMED' || row.status === 'FINALIZING') &&
        row.operation_expires_at != null &&
        row.operation_expires_at > input.now
      ) {
        conn.exec('COMMIT')
        return { status: 'busy' }
      }
      if (
        row.status !== 'ACTIVE' ||
        !row.active_lease_token ||
        row.expires_at <= input.now ||
        row.hard_expires_at < input.operationExpiresAt
      ) {
        conn.exec('COMMIT')
        return { status: 'invalid' }
      }
      let fileNames: string[]
      try {
        const parsed = JSON.parse(row.file_names) as unknown
        if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
          conn.exec('COMMIT')
          return { status: 'invalid' }
        }
        fileNames = parsed
      } catch {
        conn.exec('COMMIT')
        return { status: 'invalid' }
      }
      const claimed = conn
        .prepare(
          `UPDATE oauth_snapshots
           SET status='CLAIMED', operation_token=?, operation_expires_at=?
           WHERE state=? AND provider=? AND linuxdo_id=? AND lease_token=?
             AND status='ACTIVE' AND expires_at>? AND hard_expires_at>=?`,
        )
        .run(
          input.operationToken,
          input.operationExpiresAt,
          input.state,
          input.provider,
          input.linuxdoId,
          row.lease_token,
          input.now,
          input.operationExpiresAt,
        )
      if (claimed.changes !== 1) {
        conn.exec('ROLLBACK')
        return { status: 'busy' }
      }
      conn.exec('COMMIT')
      return {
        status: 'claimed',
        fileNames,
        leaseToken: row.lease_token,
        operationToken: input.operationToken,
      }
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  // wait/可重试故障只释放本次短 claim，保留 snapshot + provider lease 给同一会话下次继续。
  releaseOAuthOperation(state: string, leaseToken: string, operationToken: string): boolean {
    return conn
      .prepare(
        `UPDATE oauth_snapshots
         SET status='ACTIVE', operation_token=NULL, operation_expires_at=NULL
         WHERE state=? AND lease_token=? AND operation_token=?
           AND status IN ('CLAIMED', 'FINALIZING')`,
      )
      .run(state, leaseToken, operationToken).changes === 1
  },

  // 外部 await 返回后的唯一写闸门。只有仍持有 CLAIMED fencing token 的请求可进入 FINALIZING；
  // CANCEL_PENDING/CANCEL_CONFIRMED/CANCELLED tombstone 优先返回 cancelled，绝不进入 isolate/入库。
  // 上游 cancelled:true 与 auth-file 持久化并非原子；即使精确 operation token 已返回，也必须保留
  // provider fence 到 hard expiry，避免迟到文件被后继会话误认成自己的新号。
  beginOAuthFinalization(input: {
    state: string
    leaseToken: string
    operationToken: string
    now: number
  }): OAuthSessionFinalization {
    conn.exec('BEGIN IMMEDIATE')
    try {
      const row = conn
        .prepare(
          `SELECT s.provider, s.status, s.operation_expires_at, s.hard_expires_at,
                  EXISTS (
                    SELECT 1 FROM oauth_provider_leases l
                    WHERE l.provider=s.provider AND l.lease_token=s.lease_token
                      AND l.expires_at>?
                  ) AS lease_active
           FROM oauth_snapshots s
           WHERE s.state=? AND s.lease_token=? AND s.operation_token=?`,
        )
        .get(input.now, input.state, input.leaseToken, input.operationToken) as unknown as
        | {
            provider: string
            status: string
            operation_expires_at: number | null
            hard_expires_at: number | null
            lease_active: number
          }
        | undefined
      if (!row) {
        conn.exec('COMMIT')
        return { status: 'stale' }
      }
      if (
        row.status === 'CANCEL_PENDING' ||
        row.status === 'CANCEL_CONFIRMED' ||
        row.status === 'CANCELLED'
      ) {
        if (row.status === 'CANCEL_PENDING') {
          const cancelled = conn
            .prepare(
              `UPDATE oauth_snapshots SET status='CANCELLED'
               WHERE state=? AND lease_token=? AND operation_token=? AND status='CANCEL_PENDING'`,
            )
            .run(input.state, input.leaseToken, input.operationToken)
          if (cancelled.changes !== 1) {
            conn.exec('ROLLBACK')
            return { status: 'stale' }
          }
        }
        if (row.status === 'CANCEL_CONFIRMED') {
          const cancelled = conn
            .prepare(
              `UPDATE oauth_snapshots
               SET operation_token=NULL, operation_expires_at=NULL
               WHERE state=? AND lease_token=? AND operation_token=? AND status='CANCEL_CONFIRMED'`,
            )
            .run(input.state, input.leaseToken, input.operationToken)
          if (cancelled.changes !== 1) {
            conn.exec('ROLLBACK')
            return { status: 'stale' }
          }
        }
        conn.exec('COMMIT')
        return { status: 'cancelled' }
      }
      if (
        row.status !== 'CLAIMED' ||
        row.lease_active !== 1 ||
        row.operation_expires_at == null ||
        row.operation_expires_at <= input.now ||
        row.hard_expires_at == null ||
        row.hard_expires_at <= input.now
      ) {
        conn.exec('COMMIT')
        return { status: 'stale' }
      }
      const finalizing = conn
        .prepare(
          `UPDATE oauth_snapshots SET status='FINALIZING'
           WHERE state=? AND lease_token=? AND operation_token=? AND status='CLAIMED'`,
        )
        .run(input.state, input.leaseToken, input.operationToken)
      if (finalizing.changes !== 1) {
        conn.exec('ROLLBACK')
        return { status: 'stale' }
      }
      conn.exec('COMMIT')
      return { status: 'finalizing' }
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  cancelOAuthSession(input: {
    state: string
    provider: string
    linuxdoId: number
    now: number
  }): OAuthSessionCancel {
    if (!input.state) return { status: 'invalid' }
    conn.exec('BEGIN IMMEDIATE')
    try {
      const row = conn
        .prepare(
          `SELECT s.flow, s.status, s.lease_token, s.hard_expires_at,
                  EXISTS (
                    SELECT 1 FROM oauth_provider_leases l
                    WHERE l.provider=s.provider AND l.lease_token=s.lease_token
                      AND l.linuxdo_id=s.linuxdo_id AND l.expires_at>?
                  ) AS lease_active
           FROM oauth_snapshots s
           WHERE s.state=? AND s.provider=? AND s.linuxdo_id=?`,
        )
        .get(input.now, input.state, input.provider, input.linuxdoId) as unknown as
        | {
            flow: string | null
            status: string | null
            lease_token: string | null
            hard_expires_at: number | null
            lease_active: number
          }
        | undefined
      if (
        !row ||
        !row.lease_token ||
        row.hard_expires_at == null ||
        row.hard_expires_at <= input.now ||
        (row.flow !== 'redirect' && row.flow !== 'device')
      ) {
        conn.exec('COMMIT')
        return { status: 'invalid' }
      }
      if (
        row.status === 'CANCELLED' ||
        row.status === 'CANCEL_PENDING' ||
        row.status === 'CANCEL_CONFIRMED'
      ) {
        conn.exec('COMMIT')
        return {
          status: 'cancelled',
          leaseToken: row.lease_token,
          needsUpstreamCancel: row.status !== 'CANCEL_CONFIRMED' && row.lease_active === 1,
        }
      }
      if (row.status === 'FINALIZING') {
        conn.exec('COMMIT')
        return { status: 'conflict' }
      }
      if (row.status === 'CLAIMED') {
        if (row.lease_active !== 1) {
          conn.exec('COMMIT')
          return { status: 'invalid' }
        }
        const pending = conn
          .prepare(
            `UPDATE oauth_snapshots SET status='CANCEL_PENDING', cancelled_at=?
             WHERE state=? AND provider=? AND linuxdo_id=? AND status='CLAIMED'`,
          )
          .run(input.now, input.state, input.provider, input.linuxdoId)
        if (pending.changes !== 1) {
          conn.exec('ROLLBACK')
          return { status: 'conflict' }
        }
        conn.exec('COMMIT')
        return { status: 'cancelled', leaseToken: row.lease_token, needsUpstreamCancel: true }
      }
      if (row.status !== 'ACTIVE' || row.lease_active !== 1) {
        conn.exec('COMMIT')
        return { status: 'invalid' }
      }
      const cancelled = conn
        .prepare(
          `UPDATE oauth_snapshots SET status='CANCELLED', cancelled_at=?
           WHERE state=? AND provider=? AND linuxdo_id=? AND status='ACTIVE'`,
        )
        .run(input.now, input.state, input.provider, input.linuxdoId)
      if (cancelled.changes !== 1) {
        conn.exec('ROLLBACK')
        return { status: 'conflict' }
      }
      conn.exec('COMMIT')
      return { status: 'cancelled', leaseToken: row.lease_token, needsUpstreamCancel: true }
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  // 本地 tombstone 必须先落，再等待上游取消。cancelled:true 只记为 CANCEL_CONFIRMED；上游 waiter
  // 的 pending 检查与 auth-file 保存之间仍有窄竞态，因此空闲和在途会话都保留 provider fence 到
  // hard expiry。cancelled:false、取消失败或旧版 404 同样不缩短该窗口。
  confirmOAuthCancellation(input: {
    state: string
    provider: string
    linuxdoId: number
    leaseToken: string
  }): boolean {
    if (!input.state || !input.provider || !input.leaseToken) return false
    conn.exec('BEGIN IMMEDIATE')
    try {
      const row = conn
        .prepare(
          `SELECT status FROM oauth_snapshots
           WHERE state=? AND provider=? AND linuxdo_id=? AND lease_token=?
             AND status IN ('CANCEL_PENDING', 'CANCEL_CONFIRMED', 'CANCELLED')`,
        )
        .get(input.state, input.provider, input.linuxdoId, input.leaseToken) as unknown as
        | { status: string }
        | undefined
      if (!row) {
        conn.exec('COMMIT')
        return false
      }
      if (row.status === 'CANCEL_PENDING' || row.status === 'CANCELLED') {
        const confirmed = conn
          .prepare(
            `UPDATE oauth_snapshots SET status='CANCEL_CONFIRMED'
             WHERE state=? AND provider=? AND linuxdo_id=? AND lease_token=?
               AND status=?`,
          )
          .run(
            input.state,
            input.provider,
            input.linuxdoId,
            input.leaseToken,
            row.status,
          )
        if (confirmed.changes !== 1) {
          conn.exec('ROLLBACK')
          return false
        }
      }
      conn.exec('COMMIT')
      return true
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  // isolate 完成后的唯一提交点。一个短事务内重新核验 owner/provider、FINALIZING、provider lease、
  // operation fencing token 与两个 expiry，再原子插入 contribution、清本人退回记录并完成 session/lease。
  // cleanup/cancel 若在 isolate await 期间先改变状态或 token，本事务不插入任何 contribution。
  finalizeOAuthIngest(input: OAuthIngestFinalization): OAuthIngestFinalizationResult {
    if (
      !input.state ||
      !input.provider ||
      !input.leaseToken ||
      !input.operationToken ||
      (input.contribution && (
        input.contribution.method !== 'oauth' ||
        input.contribution.provider !== input.provider ||
        input.contribution.linuxdoId !== input.linuxdoId
      ))
    ) return { status: 'stale' }

    conn.exec('BEGIN IMMEDIATE')
    try {
      const row = conn
        .prepare(
          `SELECT s.status, s.operation_token, s.operation_expires_at, s.hard_expires_at,
                  l.lease_token AS active_lease_token
           FROM oauth_snapshots s
           LEFT JOIN oauth_provider_leases l
             ON l.provider=s.provider
            AND l.lease_token=s.lease_token
            AND l.linuxdo_id=s.linuxdo_id
            AND l.expires_at>?
           WHERE s.state=? AND s.provider=? AND s.linuxdo_id=? AND s.lease_token=?`,
        )
        .get(
          input.now,
          input.state,
          input.provider,
          input.linuxdoId,
          input.leaseToken,
        ) as unknown as
        | {
            status: string
            operation_token: string | null
            operation_expires_at: number | null
            hard_expires_at: number | null
            active_lease_token: string | null
          }
        | undefined

      if (!row) {
        conn.exec('COMMIT')
        return { status: 'stale' }
      }
      if (
        row.status === 'CANCEL_PENDING' ||
        row.status === 'CANCEL_CONFIRMED' ||
        row.status === 'CANCELLED'
      ) {
        conn.exec('COMMIT')
        return { status: 'cancelled' }
      }
      if (
        row.status !== 'FINALIZING' ||
        row.operation_token !== input.operationToken ||
        row.operation_expires_at == null ||
        row.operation_expires_at <= input.now ||
        row.hard_expires_at == null ||
        row.hard_expires_at <= input.now ||
        row.active_lease_token !== input.leaseToken
      ) {
        conn.exec('COMMIT')
        return { status: 'stale' }
      }

      const inserted = input.contribution ? insertContribution(input.contribution) : false
      if (inserted && input.contribution) {
        conn
          .prepare('DELETE FROM rejections WHERE linuxdo_id=? AND provider=? AND account_id=?')
          .run(input.contribution.linuxdoId, input.provider, input.contribution.accountId)
      }

      const completed = conn
        .prepare(
          `DELETE FROM oauth_snapshots
           WHERE state=? AND provider=? AND linuxdo_id=? AND lease_token=? AND operation_token=?
             AND status='FINALIZING' AND operation_expires_at>? AND hard_expires_at>?`,
        )
        .run(
          input.state,
          input.provider,
          input.linuxdoId,
          input.leaseToken,
          input.operationToken,
          input.now,
          input.now,
        )
      const released = conn
        .prepare(
          `DELETE FROM oauth_provider_leases
           WHERE provider=? AND lease_token=? AND linuxdo_id=? AND expires_at>?`,
        )
        .run(input.provider, input.leaseToken, input.linuxdoId, input.now)
      if (completed.changes !== 1 || released.changes !== 1) {
        conn.exec('ROLLBACK')
        return { status: 'stale' }
      }

      conn.exec('COMMIT')
      return { status: inserted ? 'committed' : 'duplicate' }
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  // 成功或明确终态同时释放 session 与其 provider lease。先按三 token 读 provider，再在同一短事务
  // 删除；任何 stale token 不匹配都 no-op，不能影响替换后的新会话。
  completeOAuthSession(state: string, leaseToken: string, operationToken: string): boolean {
    conn.exec('BEGIN IMMEDIATE')
    try {
      const row = conn
        .prepare(
          `SELECT provider FROM oauth_snapshots
           WHERE state=? AND lease_token=? AND operation_token=? AND status='FINALIZING'`,
        )
        .get(state, leaseToken, operationToken) as unknown as { provider: string } | undefined
      if (!row) {
        conn.exec('COMMIT')
        return false
      }
      const deleted = conn
        .prepare(
          `DELETE FROM oauth_snapshots
           WHERE state=? AND lease_token=? AND operation_token=? AND status='FINALIZING'`,
        )
        .run(state, leaseToken, operationToken)
      if (deleted.changes !== 1) {
        conn.exec('COMMIT')
        return false
      }
      conn
        .prepare('DELETE FROM oauth_provider_leases WHERE provider=? AND lease_token=?')
        .run(row.provider, leaseToken)
      conn.exec('COMMIT')
      return true
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  // start/claim 顺带做过期清理。进行中的 claim/cancel/finalize 在 operation_expires_at 前绝不删除；
  // 超时 claim 可回 ACTIVE，未知结果的取消/FINALIZING 超时 fail closed 到 CANCELLED。无论 redirect/device，
  // 所有取消结果都保留 provider fence 到 hard expiry；只有明确 terminal/success 的完成路径立即释放。
  cleanupOAuthSessions(now: number): void {
    conn.exec('BEGIN IMMEDIATE')
    try {
      conn.prepare(
        `UPDATE oauth_snapshots
         SET status='ACTIVE', operation_token=NULL, operation_expires_at=NULL
         WHERE status='CLAIMED' AND operation_expires_at<=? AND hard_expires_at>?`,
      ).run(now, now)
      conn.prepare(
        `UPDATE oauth_snapshots
         SET status='CANCELLED', operation_token=NULL, operation_expires_at=NULL
         WHERE status IN ('CANCEL_PENDING', 'FINALIZING')
           AND operation_expires_at<=?`,
      ).run(now)
      conn.prepare(
        `UPDATE oauth_snapshots
         SET operation_token=NULL, operation_expires_at=NULL
         WHERE status='CANCEL_CONFIRMED' AND operation_expires_at<=?`,
      ).run(now)
      // A timeout/worker crash leaves no proof that the upstream callback has stopped.
      // Keep that fence until hard expiry; only confirmed terminal/success paths release early.
      conn.prepare(
        `DELETE FROM oauth_provider_leases
         WHERE EXISTS (
           SELECT 1 FROM oauth_snapshots s
           WHERE s.provider=oauth_provider_leases.provider
             AND s.lease_token=oauth_provider_leases.lease_token
             AND (s.hard_expires_at IS NULL OR s.hard_expires_at<=?)
         )`,
      ).run(now)
      conn.prepare(
        `DELETE FROM oauth_snapshots
         WHERE hard_expires_at IS NULL OR status IS NULL OR hard_expires_at<=?`,
      ).run(now)
      conn.prepare('DELETE FROM oauth_provider_leases WHERE expires_at<=?').run(now)
      conn.exec('COMMIT')
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  },

  // ===== 首检退回记录（P2-R3，§3.2「告知用户登录失败/被封」）=====
  // 首检失败会删 contribution 行释放唯一键，号随即从 dashboard 消失——记一条退回，让用户知道「交了但没收、
  // 可修好重交」。reason 存中性人话（调用方给，绝不透传 CPA 原文，§8）；account_id 落库仅供归属/排查。
  recordRejection(rec: { linuxdoId: number; provider: string; accountId: string; reason: string }): void {
    conn
      .prepare(
        'INSERT INTO rejections (linuxdo_id, provider, account_id, reason, created_at) VALUES (?,?,?,?,?)',
      )
      .run(rec.linuxdoId, rec.provider, rec.accountId, rec.reason, Date.now())
  },
  // 清掉**该用户**某 (provider, account_id) 的退回记录（P2-R3）：号修好重交并成功入库后调用——否则旧
  // 退回提示「部分号未收下」会一直挂在 dashboard。必须限定 linuxdo_id（codex 于 PR #18 复审指出）：否则
  // 用户 B 交同一 account_id 成功会连带删掉用户 A 名下对该号的真实退回记录。
  clearRejections(linuxdoId: number, provider: string, accountId: string): void {
    conn
      .prepare('DELETE FROM rejections WHERE linuxdo_id=? AND provider=? AND account_id=?')
      .run(linuxdoId, provider, accountId)
  },
  // 某用户最近退回记录（dashboard 展示用），按时间倒序；limit 只取最近几条免刷屏
  rejectionsFor(linuxdoId: number, limit = 10): RejectionRow[] {
    return conn
      .prepare(
        `SELECT id, provider, account_id AS accountId, reason, created_at AS createdAt
         FROM rejections WHERE linuxdo_id=? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(linuxdoId, limit) as unknown as RejectionRow[]
  },

  // @deprecated v4（R1 拆考察期）：以下考察期观测事件 / 考察快照 / 故障顺延三组数据层函数，其消费方
  // （processPending 的考察闭环）已随 v4「按量计量」拆除，processPending 不再调用它们。函数与底层表/列
  // 一律保留（迁移不可逆、便于将来复用），暂无生产写入方；observation.test.ts 仍直接驱动验证数据层往返。
  // ===== 考察期观测事件（P2a-1）=====
  // 纯 CRUD，不含任何状态转移/发分/计时判断（那是 P2a-2/P2b）。
  // 本单只建数据层：暂无写入方——P2b/P2c 巡检时才调 addObservation；此处测试直接驱动。
  // kind 收敛为 ObservationKind：编译期挡拼错，运行时再 fail-closed 校验（防非 TS 调用方/动态值
  // 写入 'hard-fail' 之类被 hasHardFailure 漏判 → 硬失败漏发判死）。
  addObservation(contributionId: string, kind: ObservationKind, detail = ''): void {
    if (!OBSERVATION_KINDS.has(kind)) {
      throw new Error(`[db] 非法观测类型 kind='${kind}'，须为 healthy/hard_fail/soft_fail/unknown 之一`)
    }
    const now = Date.now()
    conn
      .prepare(
        'INSERT INTO observations (contribution_id, observed_at, kind, detail, created_at) VALUES (?,?,?,?,?)',
      )
      .run(contributionId, now, kind, detail, now)
  },
  // 按 observed_at 升序；同毫秒并列时以自增 id 兜底稳序（＝插入顺序），取回确定
  observationsFor(contributionId: string): Observation[] {
    return (
      conn
        .prepare(
          'SELECT id, contribution_id, observed_at, kind, detail, created_at FROM observations WHERE contribution_id=? ORDER BY observed_at ASC, id ASC',
        )
        .all(contributionId) as unknown as ObsRow[]
    ).map(toObservation)
  },
  // 是否存在 hard_fail 观测（发分判定要用：考察窗口内出现硬失败即不发分）
  hasHardFailure(contributionId: string): boolean {
    return !!conn
      .prepare("SELECT 1 FROM observations WHERE contribution_id=? AND kind='hard_fail' LIMIT 1")
      .get(contributionId)
  },

  // ===== 考察快照（P2a-1）=====
  // 进入考察：记 observe_start_at=now（计时起点）+ 冻结窗口/分值/规则版本/优先级四列。
  // compare-and-set（守 observe_start_at IS NULL）——需求 §3.4 冻结契约：进考察那刻冻结、后台改配
  // 只影响之后。worker 重试/重入若无条件重写会重启计时窗口 + 用改后的配置污染在考察的号。返回是否
  // 真正初始化了（changes>0）；已在考察则返回 false、快照岿然不动。幂等，与 awardPoints/transition 同调。
  startObservation(
    contributionId: string,
    snap: { windowMs: number; points: number; ruleVersion: string; priority: number },
  ): boolean {
    const now = Date.now()
    const r = conn
      .prepare(
        `UPDATE contributions
         SET observe_start_at=?, observe_window_ms=?, snapshot_points=?,
             snapshot_rule_version=?, snapshot_priority=?, updated_at=?
         WHERE id=? AND observe_start_at IS NULL`,
      )
      .run(now, snap.windowMs, snap.points, snap.ruleVersion, snap.priority, now, contributionId)
    return r.changes > 0
  },
  // 读回五个快照字段；未进考察（或无此号）时 observeStartAt 等均为 null
  getObservationSnapshot(contributionId: string): {
    observeStartAt: number | null
    observeWindowMs: number | null
    snapshotPoints: number | null
    snapshotRuleVersion: string | null
    snapshotPriority: number | null
  } {
    const r = conn
      .prepare(
        'SELECT observe_start_at, observe_window_ms, snapshot_points, snapshot_rule_version, snapshot_priority FROM contributions WHERE id=?',
      )
      .get(contributionId) as unknown as
      | {
          observe_start_at: number | null
          observe_window_ms: number | null
          snapshot_points: number | null
          snapshot_rule_version: string | null
          snapshot_priority: number | null
        }
      | undefined
    return {
      observeStartAt: r?.observe_start_at ?? null,
      observeWindowMs: r?.observe_window_ms ?? null,
      snapshotPoints: r?.snapshot_points ?? null,
      snapshotRuleVersion: r?.snapshot_rule_version ?? null,
      snapshotPriority: r?.snapshot_priority ?? null,
    }
  },

  // ===== 故障顺延记账（P2b §3.2）=====
  // 考察窗口 T 只在「可观测时段」流逝：不可观测（worker 停机 / inspect 失败 / 本站重启）时段暂停计时。
  // 用「暂停时长累积」近似——worker 每轮成功观测时，把超出预期间隔的观测空洞累加进 observe_paused_ms；
  // 到期判定用「wall-clock − observe_paused_ms」（见 collect.settle）。这两列独立于考察快照五列
  // （故意不并入 getObservationSnapshot：保其返回形状稳定，不惊动既有 deepEqual 测试）。

  // 记一次成功观测：更新 last_observed_at=本次观测时刻 + 累加暂停增量 addPausedMs（0 亦可，正常轮）。
  // COALESCE 兜 null→0（migration 006 加列时既有 observing 行为 null）。仅成功观测调用；unknown 轮不调，
  // 故 last_observed_at 停在上次成功观测——下次成功观测时那段空洞会被算进暂停（§3.2 顺延语义）。
  // ⚠️ 单实例假设：无条件累加 observe_paused_ms。首版部署形态为单机单实例单 worker（processPending
  // 有 running 锁串行），故不会并发。多实例演进（换 PostgreSQL/worker 独立进程）时须改 CAS——守
  // last_observed_at=期望旧值，否则多 worker 各读同一 last_observed_at、把同一次停机重复累加。见路线图。
  recordObserveTick(
    contributionId: string,
    tick: { lastObservedAt: number; addPausedMs: number },
  ): void {
    const now = Date.now()
    conn
      .prepare(
        `UPDATE contributions
         SET last_observed_at=?, observe_paused_ms=COALESCE(observe_paused_ms, 0) + ?, updated_at=?
         WHERE id=?`,
      )
      .run(tick.lastObservedAt, tick.addPausedMs, now, contributionId)
  },
  // 读回暂停累积与上次成功观测时刻。pausedMs：null→0（settle 用它扣减 wall-clock）；
  // lastObservedAt：null＝尚无成功观测（记账时以 observeStartAt 兜底作空洞起点）。
  getObserveTick(contributionId: string): { pausedMs: number; lastObservedAt: number | null } {
    const r = conn
      .prepare('SELECT observe_paused_ms, last_observed_at FROM contributions WHERE id=?')
      .get(contributionId) as unknown as
      | { observe_paused_ms: number | null; last_observed_at: number | null }
      | undefined
    return {
      pausedMs: r?.observe_paused_ms ?? 0,
      lastObservedAt: r?.last_observed_at ?? null,
    }
  },

  // ===== 审计留痕（P4-R1，§7.3）=====
  // 记一条操作留痕：操作人 actor / 时间 / 动作 / 目标 / 旧值 / 新值。old/new 为**已脱敏摘要**（由 lib/audit.ts
  // 构造，绝不含 CDK 码/密钥等敏感原文，§8）；undefined → 落 null。actor 取结构最小型（不 import lib/admin，
  // 免 db 反向依赖 next/headers；admin.Actor 结构兼容）。本方法不自行开事务：管理写调用方用
  // withTransaction() 将主变更与审计原子提交；异常一律上抛不吞（审计失败必须让主变更回滚）。
  recordAudit(
    actor: { type: string; id?: number; label: string },
    entry: { action: string; target: string; old?: unknown; new?: unknown },
  ): void {
    conn
      .prepare(
        `INSERT INTO audit_log (actor_type, actor_id, actor_label, action, target, old_value, new_value, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        actor.type,
        actor.id ?? null,
        actor.label,
        entry.action,
        entry.target,
        entry.old === undefined ? null : JSON.stringify(entry.old),
        entry.new === undefined ? null : JSON.stringify(entry.new),
        Date.now(),
      )
  },
  // 管理写操作把主变更与审计放在同一事务内；审计落库失败时主变更一并回滚，
  // 客户端收到可安全重试的失败，不会出现“状态已变但没有审计”的半成功。
  withTransaction<T>(work: () => T): T {
    conn.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      conn.exec('COMMIT')
      return result
    } catch (error) {
      try {
        conn.exec('ROLLBACK')
      } catch {
        // 保留原始业务/审计错误；readiness 与 API 层会统一脱敏返回。
      }
      throw error
    }
  },
  // 审计查看（倒序分页，最新在前）：limit 钳 [1,200]、offset 钳 ≥0 防脏输入。old/new 本就是脱敏摘要，不泄敏感值。
  // 按 id DESC（自增＝插入序＝时间序，比 created_at 更稳、无同毫秒并列歧义）。
  listAudit(limit = 50, offset = 0): AuditRow[] {
    const lim = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
    // offset 归一（codex 复审 P3）：非有限值（尤其 +Infinity——Number('Infinity')=Infinity 是真值、会绕过
    // `||0`，Math.floor 后原样穿到 node:sqlite 的 OFFSET 绑定抛错＝脏输入变 500）一律回落 0。limit 侧 Math.min(200,…) 天然封顶不受影响。
    const nOff = Number(offset)
    const off = Number.isFinite(nOff) ? Math.max(0, Math.floor(nOff)) : 0
    return conn
      .prepare(
        `SELECT id, actor_type AS actorType, actor_id AS actorId, actor_label AS actorLabel,
                action, target, old_value AS oldValue, new_value AS newValue, created_at AS createdAt
         FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off) as unknown as AuditRow[]
  },

  // ===== 管理侧全局分页只读（P4-R3，§6.146）=====
  // 现有 byUser/settlementsFor/listRedemptions 全是用户侧；此三个是**管理侧全局**分页只读（倒序、limit/offset
  // 钳制仿 listAudit）。§8 脱敏红线：贡献记录不返回 email/reward_code；兑换记录绝不返回 result（CDK 码原文）。
  // 三者均 SELECT 明确列（非 SELECT *），从结构上杜绝敏感列外泄。

  // 贡献记录：全局倒序（created_at DESC，id 次序稳定）。points＝该号累计发分（页内每行调 contributionPoints）。
  // ⚠️ 只 SELECT 展示列——不含 email / reward_code（管理列表无需，最小暴露）。
  listContributionsAdmin(limit = 50, offset = 0): AdminContributionRow[] {
    const lim = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
    // offset 归一（codex 复审 P3）：非有限值（尤其 +Infinity——Number('Infinity')=Infinity 是真值、会绕过
    // `||0`，Math.floor 后原样穿到 node:sqlite 的 OFFSET 绑定抛错＝脏输入变 500）一律回落 0。limit 侧 Math.min(200,…) 天然封顶不受影响。
    const nOff = Number(offset)
    const off = Number.isFinite(nOff) ? Math.max(0, Math.floor(nOff)) : 0
    const rows = conn
      .prepare(
        `SELECT id, linuxdo_id AS linuxdoId, username, provider, plan, account_id AS accountId,
                verify_status AS verifyStatus, created_at AS createdAt
         FROM contributions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off) as unknown as Omit<AdminContributionRow, 'points'>[]
    return rows.map((r) => ({ ...r, points: db.contributionPoints(r.id) }))
  },

  // 每日用量结算记录：全局倒序（id DESC＝自增插入序）。LEFT JOIN contributions 取 username/linuxdo_id；
  // 纯结算行理论都有对应号（join 取得到），取不到则 username 空串、linuxdoId null 兜底。
  listSettlementsAdmin(limit = 50, offset = 0): AdminSettlementRow[] {
    const lim = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
    // offset 归一（codex 复审 P3）：非有限值（尤其 +Infinity——Number('Infinity')=Infinity 是真值、会绕过
    // `||0`，Math.floor 后原样穿到 node:sqlite 的 OFFSET 绑定抛错＝脏输入变 500）一律回落 0。limit 侧 Math.min(200,…) 天然封顶不受影响。
    const nOff = Number(offset)
    const off = Number.isFinite(nOff) ? Math.max(0, Math.floor(nOff)) : 0
    return conn
      .prepare(
        `SELECT s.id, s.contribution_id AS contributionId, c.linuxdo_id AS linuxdoId,
                COALESCE(c.username, '') AS username, s.date, s.provider,
                s.account_id AS accountId, s.call_count AS callCount, s.points, s.settled_at AS settledAt
         FROM daily_settlements s
         LEFT JOIN contributions c ON c.id = s.contribution_id
         ORDER BY s.id DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off) as unknown as AdminSettlementRow[]
  },

  // 兑换记录：全局倒序（created_at DESC，id 次序稳定）。子查询按 linuxdo_id 取任一 username（纯兑换用户
  // 可能无贡献号 → username 空串、前端显示 linuxdoId 数字兜底）。
  // 🔴 §8 铁律：绝不 SELECT / 返回 result（存 CDK 兑换码原文，「不进他人可见接口」的敏感值）。
  //   管理侧全局兑换记录只回状态/商品/花费/时间/归属人。
  listRedemptionsAdmin(limit = 50, offset = 0): AdminRedemptionRow[] {
    const lim = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
    // offset 归一（codex 复审 P3）：非有限值（尤其 +Infinity——Number('Infinity')=Infinity 是真值、会绕过
    // `||0`，Math.floor 后原样穿到 node:sqlite 的 OFFSET 绑定抛错＝脏输入变 500）一律回落 0。limit 侧 Math.min(200,…) 天然封顶不受影响。
    const nOff = Number(offset)
    const off = Number.isFinite(nOff) ? Math.max(0, Math.floor(nOff)) : 0
    return conn
      .prepare(
        `SELECT r.id, r.linuxdo_id AS linuxdoId,
                COALESCE((SELECT username FROM contributions WHERE linuxdo_id = r.linuxdo_id LIMIT 1), '') AS username,
                r.item_name AS itemName, r.cost, r.status, r.created_at AS createdAt
         FROM redemptions r ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off) as unknown as AdminRedemptionRow[]
  },

  // 后台顶部概览使用数据库真实总数；不能拿「最新 50 条」页面数组长度冒充全局统计。
  adminOverview(): AdminOverview {
    const row = conn
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM contributions WHERE verify_status='pooled') AS pooledAccounts,
           (SELECT COUNT(*) FROM contributions WHERE verify_status='needs_review') AS needsReview,
           (SELECT COUNT(*) FROM redemptions WHERE status='pending') AS pendingRedemptions,
           (SELECT COUNT(*) FROM redeem_items WHERE enabled=1) AS enabledRedeemItems`,
      )
      .get() as unknown as AdminOverview
    return { ...row }
  },

  // Readiness：验证连接、canonical schema/唯一约束与主库写锁；仅代表本地 SQLite 可供当前代码读写。
  // 只抛异常给 /api/ready 转成脱敏 503，不把路径、SQL 或内部错误透给 UI。
  assertReady(): void {
    // 业务连接保留 5s busy_timeout 以覆盖正常启动/种子并发；readiness 的写探针必须
    // 使用独立短超时连接，否则外部 BEGIN IMMEDIATE 会同步冻结 liveness。
    const inMemory = DB_PATH === ':memory:' || DB_PATH.startsWith('file::memory:')
    const probe = inMemory ? undefined : () => new DatabaseSync(DB_PATH)
    assertDatabaseReady(conn, probe)
  },

  // ===== 人工复核处理（P4-R3，§7.4）=====
  // needs_review 号（拿不到稳定 account_id 的残缺号 / 首检 OAuth 失效 reauth）现无任何自动出口＝死胡同。
  // 两动作都只走 transition CAS 改 verify_status，**完全不碰 daily_settlements / point_ledger**，故天然满足
  // §7.4：人工重试不触发 reconciliation、终止不删已有累计水位/账本。CAS from=['needs_review']
  // 亦防并发/状态已变时误操作（对非 needs_review 号调用返 false 不改）。

  // 重试：按 pooled_at 分叉去向（codex 复审 P1）。needs_review 有两类，不能一律回首检：
  //   ① 从没入池（首检 reauth / 残缺号，pooled_at IS NULL）→ 回首检队列 'submitted'，processPending 下轮
  //      重新首检（残缺号可能仍拿不到 ID、reauth 号若已重授权则可过）。此类若 cpa reject，processPending
  //      deleteContribution 删行释放唯一键本就是 §2.4 设计（从没入池的号允许修好重交），安全。
  //   ② 入过池（巡检 checkPooledHealth 把 pooled→needs_review，pooled_at 非空）→ **直接回池 'pooled'**，绝不回首检：
  //      a) 回首检 → processPending 入池经 transitionToPool 用新时间**覆写 pooled_at**（:406 单条 UPDATE 无
  //         COALESCE）→ settleDailyUsage 下界 `u.date <= dayStr(pooledAt)` 后移 → 重试日之前未结的历史欠薪
  //         **永久跳过**（migration 010「入过池补结欠薪」被冲垮）。
  //      b) 回首检若 cpa reject → processPending deleteContribution **删行释放唯一键** → 违反 §2.4「成功入池的
  //         号一辈子只交一次、失效也不重交」。
  //      直接 transition→'pooled'：pooled_at 原值不动（transition 只改 verify_status）＝结算下界不移、欠薪照补；
  //      不进首检管道＝不可能触发删行；号若实际仍坏，checkPooledHealth 下轮巡检再转出去（pooled 态常规守护者，
  //      语义自洽）。
  // 读后 CAS 无竞态：pooled_at 只由 transitionToPool（from=submitted/first_check）写，本行处 needs_review 期间
  //   不可能被写；verify_status 由下面 transition 的 CAS 自身守（仅当仍 needs_review 才转）。返回是否真转。
  retryReview(id: string): boolean {
    const r = conn.prepare('SELECT pooled_at FROM contributions WHERE id=?').get(id) as unknown as
      | { pooled_at: number | null }
      | undefined
    if (!r) return false
    const to = r.pooled_at != null ? 'pooled' : 'submitted'
    return db.transition(id, ['needs_review'], to)
  },
  // 终止：标记放弃、退出人工队列、保留行与审计痕迹。选 stopped 不删行：needs_review 从没入池
  // （pooled_at 为 null）→ 转 stopped 后不进 eligibleForSettlement（该集按 pooled_at IS NOT NULL 过滤、
  // 不看 verify_status），不影响结算；保留行便于审计追溯。
  terminateReview(id: string): boolean {
    return db.transition(id, ['needs_review'], 'stopped')
  },

  // ===== readiness 只读探针（P6-R2，§9）=====
  // 同时验证两件此前被混为一谈的事实：① 应用实际在用的常驻连接仍活着；② DB_PATH 当前仍指向
  // 启动时打开的同一 dev/inode，并且新连接能从最终磁盘文件重跑 canonical schema + 写探针。
  // 只做其中任一半都会假绿：
  // 新连接证明不了常驻连接；常驻连接在路径被 unlink/rename 后又会继续读写已不可见的旧 inode。
  // fresh 连接不使用 immutable=1：运行中的库是 WAL，immutable 会忽略 WAL 里尚未 checkpoint 的已提交状态。
  // DB_PATH 在 stat/open/stat 间变化会抛错或身份不匹配，由调用方统一判 503；fresh 连接始终 finally close。
  // 🔴 §8：只回布尔/版本号，绝不回库路径、dev/ino、配置或任何业务数据。
  readyProbe(): {
    alive: number
    residentSchemaVersion: number | null
    dbPathExists: boolean
    dbPathMatchesOpenedFile: boolean
    diskSchemaVersion: number | null
  } {
    const resident = connection()
    const openedDbPath = g.__appDbPath
    const openedDbIdentity = g.__appDbIdentity
    const r = resident.prepare('SELECT 1 AS ok').get() as unknown as { ok: number } | undefined
    const residentSchemaVersion = readSchemaVersion(resident)

    // 测试/工具进程可显式使用 :memory:；它没有磁盘路径或 inode，磁盘侧判据退化为同一常驻连接。
    if (DB_PATH === ':memory:') {
      return {
        alive: r?.ok ?? 0,
        residentSchemaVersion,
        dbPathExists: true,
        dbPathMatchesOpenedFile: openedDbPath === DB_PATH && openedDbIdentity === null,
        diskSchemaVersion: residentSchemaVersion,
      }
    }

    let currentIdentity: DbFileIdentity
    try {
      currentIdentity = dbFileIdentity() as DbFileIdentity
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          alive: r?.ok ?? 0,
          residentSchemaVersion,
          dbPathExists: false,
          dbPathMatchesOpenedFile: false,
          diskSchemaVersion: null,
        }
      }
      throw err
    }

    const pathMatches =
      openedDbPath === DB_PATH &&
      openedDbIdentity != null &&
      sameDbFile(openedDbIdentity, currentIdentity)
    if (!pathMatches) {
      return {
        alive: r?.ok ?? 0,
        residentSchemaVersion,
        dbPathExists: true,
        dbPathMatchesOpenedFile: false,
        diskSchemaVersion: null,
      }
    }

    const disk = new DatabaseSync(DB_PATH)
    try {
      disk.exec('PRAGMA busy_timeout = 50')
      assertDatabaseReady(disk)
      const diskSchemaVersion = readSchemaVersion(disk)
      const finalIdentity = dbFileIdentity() as DbFileIdentity
      return {
        alive: r?.ok ?? 0,
        residentSchemaVersion,
        dbPathExists: true,
        dbPathMatchesOpenedFile:
          sameDbFile(openedDbIdentity, finalIdentity) && sameDbFile(currentIdentity, finalIdentity),
        diskSchemaVersion,
      }
    } finally {
      disk.close()
    }
  },
}

export interface AuditRow {
  id: number
  actorType: string
  actorId: number | null
  actorLabel: string
  action: string
  target: string
  oldValue: string | null // JSON 摘要字符串（脱敏后）或 null
  newValue: string | null
  createdAt: number
}

// ===== 管理侧全局分页只读行（P4-R3，§6.146）=====
// 贡献记录（脱敏：无 email/reward_code）。points＝该号累计发分（daily_settlements 汇总）。
export interface AdminContributionRow {
  id: string
  linuxdoId: number
  username: string
  provider: string
  plan: string
  accountId: string
  verifyStatus: string
  points: number
  createdAt: number
}
// 每日用量结算记录。linuxdoId/username 由 LEFT JOIN contributions 取；取不到 → null/空串兜底。
export interface AdminSettlementRow {
  id: number
  contributionId: string
  linuxdoId: number | null
  username: string
  date: string
  provider: string
  accountId: string
  callCount: number
  points: number
  settledAt: number
}
// 兑换记录（🔴 §8：绝不含 result＝CDK 码原文）。username 由 linuxdo_id 子查询取，纯兑换用户可能为空串。
export interface AdminRedemptionRow {
  id: string
  linuxdoId: number
  username: string
  itemName: string
  cost: number
  status: string
  createdAt: number
}
export interface AdminOverview {
  pooledAccounts: number
  needsReview: number
  pendingRedemptions: number
  enabledRedeemItems: number
}

export interface PointRule {
  id: number
  provider: string
  plan: string
  points: number
  enabled: number
  label: string
}
export interface UsageRate {
  id: number
  provider: string
  plan: string
  pointsPerCall: number // usage_rates.points_per_call（REAL，可小数）
  enabled: number
  label: string
}
export interface RedeemItem {
  id: number
  name: string
  description: string
  cost: number
  kind: string // 展示分类（图标/文案）：permanent_quota/timed_quota/vip/invite_code/ldc
  enabled: number
  sort: number
  config: string
  // 履约类型（P3-R1）：placeholder 占位文案 / cdk 库存发码。默认 placeholder（既有种子项保持占位）
  fulfillment: string
  // 每人限购件数（P3-R1）：0＝不限（默认）
  perUserLimit: number
}
export interface RedeemItemCreateRequest {
  requestKey: string
  payloadHash: string
  itemId: number
  createdAt: number
}
export interface RedemptionRow {
  id: string
  itemName: string
  cost: number
  status: string
  result: string
  createdAt: number
}
export interface DailySettlement {
  id: number
  contributionId: string
  date: string // 'YYYY-MM-DD'
  provider: string
  accountId: string
  callCount: number
  points: number
  settledAt: number
}
export interface RejectionRow {
  id: number
  provider: string
  accountId: string
  reason: string
  createdAt: number
}
export interface LedgerEntry {
  id: number
  delta: number
  reason: string
  ref: string
  createdAt: number
}

// ============================================================================
// 展示助手（P2-R3，§6）：把裸数据转 dashboard 人话。纯函数、无 DB 依赖，便于直接单测。
// 铁律（§8）：绝不返回完整敏感号 / email / token——账号一律掩码成「provider 中文名 + 尾 4 位」。
// ============================================================================
const PROVIDER_CN: Record<string, string> = { codex: 'ChatGPT', claude: 'Claude', grok: 'Grok' }

// 账号短标识：中文 provider + accountId 尾 4 位（不足 4 位则原样，空则仅 provider）。
// 例：('codex','acct_1a2b3c4d') → 'ChatGPT·3c4d'。绝不返回完整 accountId/email/token。
export function shortAccountLabel(provider: string, accountId: string): string {
  const name = PROVIDER_CN[provider] ?? provider
  const id = accountId || ''
  const tail = id.length > 4 ? id.slice(-4) : id
  return tail ? `${name}·${tail}` : name
}

// 一笔积分流水 → 中文原因文案。usage 笔解析首次 ref 或带目标累计次数的补差 ref，
// 显示「〔账号〕M 月 D 日 用量结算」；其它 reason（redeem / 贡献老笔）给稳定中文、原样保留。
// accountOf：cid → 该号 (provider, accountId)，由调用方按用户号表构建（解析不到则回落「账号」）。
export function describeLedgerEntry(
  e: { reason: string; ref: string },
  accountOf: (cid: string) => { provider: string; accountId: string } | undefined,
): string {
  if (e.reason === 'usage') {
    const m = /^usage:([^:]+):(\d{4})-(\d{2})-(\d{2})(?::calls:\d+)?$/.exec(e.ref)
    if (m) {
      const acct = accountOf(m[1])
      const who = acct ? shortAccountLabel(acct.provider, acct.accountId) : '账号'
      return `〔${who}〕${Number(m[3])} 月 ${Number(m[4])} 日 用量结算`
    }
    return '用量结算'
  }
  if (e.reason === 'redeem') return '积分兑换'
  if (e.reason === 'contribution') return '贡献奖励'
  return '积分变动'
}
