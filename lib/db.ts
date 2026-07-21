import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { assertSchemaCurrent, migrate } from './migrate'
import { env } from './env'

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

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')

function openDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const d = new DatabaseSync(DB_PATH)
  // busy_timeout 必须先设：它一设即生效且自身不取锁，随后所有取锁语句（WAL 建立、seedDefaults 的
  // BEGIN IMMEDIATE）都受这 5s 等待保护。若顺序颠倒，next build 多 worker 同刻 openDb 争 WAL 建立
  // 的短暂排他锁时，journal_mode=WAL 会以 busy_timeout=0 立刻抛 "database is locked"（无重试）。
  d.exec('PRAGMA busy_timeout = 5000')
  d.exec('PRAGMA journal_mode = WAL')
  // 迁移纪律：生产（非 mock）只校验 schema 版本，迁移由部署步骤 `npm run migrate` 执行；
  // mock（开发/演示）保持启动自动迁移。
  if (env.mock) migrate(d)
  else assertSchemaCurrent(d)
  seedDefaults(d)
  return d
}

// 首次运行播种合理默认值（管理页可随时改）。仅在表为空时插入。
// ⚠️ 并发播种竞态（TOCTOU）：next build 并行拉起多个 worker 进程，各自 openDb→seedDefaults 打同一
// data/app.db。每块「SELECT COUNT==0 then INSERT」非原子，两进程同读 count=0 再各插 →
//   point_rules / usage_rates（UNIQUE(provider,plan)）撞唯一键抛错 → build 挂；
//   redeem_items（无唯一键）静默插两份种子（4→8）；app_config（key 为 PRIMARY KEY）同样会撞。
// 修法：整个函数体包进 BEGIN IMMEDIATE 单事务（openDb 已设 busy_timeout=5s）。先到者持写锁播完提交，
// 后到者阻塞至提交后、其读到各表 count>0 全部跳过——一处修好所有块及任何未来种子表，且不改任何
// 单条 INSERT / 种子值。与 migrate() / settleAndAward 同款「BEGIN IMMEDIATE 兼作并发锁」模式。
// export：供 test/seed-concurrency.test.ts 直接驱动并发（子进程各开 target 连接、对齐后调本函数），
// 测其 BEGIN IMMEDIATE 原子播种。生产无其它调用方（仅 openDb 内部用）。
export function seedDefaults(d: DatabaseSync): void {
  d.exec('BEGIN IMMEDIATE')
  try {
    const ruleCount = (d.prepare('SELECT COUNT(*) AS n FROM point_rules').get() as { n: number }).n
    if (ruleCount === 0) {
      const rules: [string, string, number, string][] = [
        ['codex', 'plus', 10, 'ChatGPT Plus'],
        ['codex', 'pro', 30, 'ChatGPT Pro'],
        ['codex', 'team', 50, 'ChatGPT Team'],
        ['codex', 'edu', 20, 'ChatGPT Edu / K12'],
        ['codex', '*', 5, 'ChatGPT 其它'],
        ['claude', '*', 20, 'Claude'],
        ['grok', '*', 20, 'SuperGrok'],
      ]
      const stmt = d.prepare(
        'INSERT INTO point_rules (provider, plan, points, label) VALUES (?,?,?,?)',
      )
      for (const [p, pl, pts, label] of rules) stmt.run(p, pl, pts, label)
    }
    // 用量单价（usage_rates，P2-R2）：每次调用积分单价，占位值、后台可调（管理 UI 留 R3）。分档演示
    // codex-pro 高于 plus；claude/grok 用兜底档。数字皆占位——需求 §3.4「数字全为占位、随时调」。
    const rateCount = (d.prepare('SELECT COUNT(*) AS n FROM usage_rates').get() as { n: number }).n
    if (rateCount === 0) {
      const rates: [string, string, number, string][] = [
        ['codex', 'plus', 1, 'Codex Plus 每次调用'],
        ['codex', 'pro', 2, 'Codex Pro 每次调用'],
        ['codex', '*', 1, 'Codex 其它每次调用'],
        ['claude', '*', 1, 'Claude 每次调用'],
        ['grok', '*', 1, 'SuperGrok 每次调用'],
      ]
      // ON CONFLICT DO NOTHING：P2-R2 本块先行止血的幂等插入。现整个 seedDefaults 已包进外层
      // BEGIN IMMEDIATE 单事务，此 ON CONFLICT 成冗余兜底、保留无害（不再单独依赖它防并发）。
      const stmt = d.prepare(
        `INSERT INTO usage_rates (provider, plan, points_per_call, label) VALUES (?,?,?,?)
         ON CONFLICT(provider, plan) DO NOTHING`,
      )
      for (const [p, pl, ppc, label] of rates) stmt.run(p, pl, ppc, label)
    }
    const itemCount = (d.prepare('SELECT COUNT(*) AS n FROM redeem_items').get() as { n: number }).n
    if (itemCount === 0) {
      const items: [string, string, number, string, number][] = [
        ['限时额度（高）', '较高额度，限时使用', 50, 'timed_quota', 1],
        ['永久额度', '永久有效的额度', 100, 'permanent_quota', 2],
        ['注册邀请码', '公益站注册邀请码 ×1', 150, 'invite_code', 3],
        ['订阅 VIP', '一段时间的 VIP 订阅', 200, 'vip', 4],
      ]
      const stmt = d.prepare(
        'INSERT INTO redeem_items (name, description, cost, kind, sort) VALUES (?,?,?,?,?)',
      )
      for (const [n, desc, cost, kind, sort] of items) stmt.run(n, desc, cost, kind, sort)
    }
    // 考察窗口 T 默认值（app_config KV）：mock 8s 便于演示 / 真实 24h。仅键缺失时播种，管理页可改。
    if (d.prepare('SELECT 1 FROM app_config WHERE key=?').get('observe_window_ms') == null) {
      d.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)').run(
        'observe_window_ms',
        String(env.mock ? 8000 : 86_400_000),
        Date.now(),
      )
    }
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

// 跨热更新复用同一连接
const g = globalThis as unknown as { __appDb?: DatabaseSync }
const conn: DatabaseSync = g.__appDb ?? (g.__appDb = openDb())

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

// 按日结算行（P2-R2）：daily_settlements 一行 = 某号某自然日一笔结算
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
    const r = conn
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
      )
    return { duplicate: r.changes === 0 }
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

  // 排行榜按「已入池号数」排名（v4：granted 态取消，成功首检入池即计数；真正的按累计积分排名待 R2/R3）。
  leaderboard(limit = 20): { linuxdoId: number; username: string; count: number }[] {
    return conn
      .prepare(
        `SELECT linuxdo_id AS linuxdoId, username, COUNT(*) AS count
         FROM contributions WHERE verify_status = 'pooled'
         GROUP BY linuxdo_id ORDER BY count DESC, MIN(created_at) ASC LIMIT ?`,
      )
      .all(limit) as unknown as { linuxdoId: number; username: string; count: number }[]
  },

  // 我的排名与入池数（用于榜单外也能看到自己的名次）
  myRank(linuxdoId: number): { rank: number; count: number } {
    const mine = conn
      .prepare(
        `SELECT COUNT(*) AS count FROM contributions
         WHERE verify_status = 'pooled' AND linuxdo_id = ?`,
      )
      .get(linuxdoId) as unknown as { count: number }
    const count = mine?.count ?? 0
    if (count === 0) return { rank: 0, count: 0 }
    // 排名 = 入池数比我多的人数 + 1
    const ahead = conn
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT linuxdo_id, COUNT(*) AS c FROM contributions
           WHERE verify_status = 'pooled' GROUP BY linuxdo_id HAVING c > ?
         )`,
      )
      .get(count) as unknown as { n: number }
    return { rank: (ahead?.n ?? 0) + 1, count }
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
  deletePointRule(id: number): void {
    conn.prepare('DELETE FROM point_rules WHERE id=?').run(id)
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
  }): void {
    if (it.id) {
      conn
        .prepare(
          `UPDATE redeem_items SET name=?, description=?, cost=?, kind=?, enabled=?, sort=?, config=?,
             fulfillment=COALESCE(?, fulfillment), per_user_limit=COALESCE(?, per_user_limit) WHERE id=?`,
        )
        .run(
          it.name, it.description, it.cost, it.kind, it.enabled ? 1 : 0, it.sort, it.config ?? '{}',
          it.fulfillment ?? null, it.perUserLimit ?? null, it.id,
        )
    } else {
      conn
        .prepare(
          `INSERT INTO redeem_items (name, description, cost, kind, enabled, sort, config, fulfillment, per_user_limit)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          it.name, it.description, it.cost, it.kind, it.enabled ? 1 : 0, it.sort, it.config ?? '{}',
          it.fulfillment ?? 'placeholder', it.perUserLimit ?? 0,
        )
    }
  },
  deleteRedeemItem(id: number): void {
    conn.prepare('DELETE FROM redeem_items WHERE id=?').run(id)
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

  // 记一笔当日结算：INSERT，(contribution_id, date) 冲突则 DO NOTHING（按日结算幂等）。返回是否本次真正落库。
  // 这是「同号同日只结一次」的第一道闸；发分幂等由 awardPoints 的 UNIQUE(reason, ref) 兜第二道。
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

  // 该号该日是否已结算（settleDailyUsage 的快速跳过闸；真正防重复结算/发分靠两层 UNIQUE 约束）
  hasSettled(contributionId: string, date: string): boolean {
    return !!conn
      .prepare('SELECT 1 FROM daily_settlements WHERE contribution_id=? AND date=? LIMIT 1')
      .get(contributionId, date)
  },

  // 发分 + 记结算：**同一事务**（codex xhigh 于 PR #16 指出：两写分离时，夹缝崩溃会让下轮以变化后的
  // 用量/单价补记 settlement，与已入账的 ledger 笔数值分叉）。BEGIN IMMEDIATE 内两写同成同败；两层
  // UNIQUE（point_ledger(reason,ref) / daily_settlements(contribution_id,date)）仍各自幂等兜底。
  // 返回 { settled, awarded }＝本次是否真正落库/入账。
  settleAndAward(rec: {
    contributionId: string
    date: string
    provider: string
    accountId: string
    callCount: number
    points: number
    linuxdoId: number
  }): { settled: boolean; awarded: boolean } {
    conn.exec('BEGIN IMMEDIATE')
    try {
      let awarded = false
      if (rec.points > 0) {
        awarded = db.awardPoints(rec.linuxdoId, rec.points, 'usage', `usage:${rec.contributionId}:${rec.date}`)
      }
      const settled = db.recordSettlement(rec)
      conn.exec('COMMIT')
      return { settled, awarded }
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

  // ===== OAuth 授权快照（P1b-4：按 state 持久化跨请求）=====
  // startOAuth 授权前拍 auth-files 文件名快照并按 state 存；finishOAuth/checkOAuth 读同一份作
  // findNew 的 before（挡号池既有号）；成功入库后删；过期清理。file_names 以 JSON 数组存。
  setOAuthSnapshot(state: string, fileNames: string[]): void {
    conn
      .prepare(
        `INSERT INTO oauth_snapshots (state, file_names, created_at) VALUES (?,?,?)
         ON CONFLICT(state) DO UPDATE SET file_names=excluded.file_names, created_at=excluded.created_at`,
      )
      .run(state, JSON.stringify(fileNames), Date.now())
  },
  // 无记录返回 null；JSON 解析失败也返回 null（调用方 ?? [] 降级为空 before＝仍安全）
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
  deleteOAuthSnapshot(state: string): void {
    conn.prepare('DELETE FROM oauth_snapshots WHERE state=?').run(state)
  },
  // 删掉 created_at 早于 now-olderThanMs 的过期快照（startOAuth 顺带调用，防表无限增长）
  cleanupOAuthSnapshots(olderThanMs: number): void {
    conn.prepare('DELETE FROM oauth_snapshots WHERE created_at < ?').run(Date.now() - olderThanMs)
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
  // 免 db 反向依赖 next/headers；admin.Actor 结构兼容）。与主操作紧邻调用（非同事务）：单机单 worker 下
  // 主写与本写各自 auto-commit、先后紧邻；本 INSERT 无唯一约束不会失败，异常一律上抛不吞（审计不静默丢）。
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
  // 审计查看（倒序分页，最新在前）：limit 钳 [1,200]、offset 钳 ≥0 防脏输入。old/new 本就是脱敏摘要，不泄敏感值。
  // 按 id DESC（自增＝插入序＝时间序，比 created_at 更稳、无同毫秒并列歧义）。
  listAudit(limit = 50, offset = 0): AuditRow[] {
    const lim = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
    const off = Math.max(0, Math.floor(Number(offset) || 0))
    return conn
      .prepare(
        `SELECT id, actor_type AS actorType, actor_id AS actorId, actor_label AS actorLabel,
                action, target, old_value AS oldValue, new_value AS newValue, created_at AS createdAt
         FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off) as unknown as AuditRow[]
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

export interface PointRule {
  id: number
  provider: string
  plan: string
  points: number
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

// 一笔积分流水 → 中文原因文案。usage 笔解析 ref（'usage:<cid>:YYYY-MM-DD'）出日期 + 账号短标识，
// 显示「〔账号〕M 月 D 日 用量结算」；其它 reason（redeem / 贡献老笔）给稳定中文、原样保留。
// accountOf：cid → 该号 (provider, accountId)，由调用方按用户号表构建（解析不到则回落「账号」）。
export function describeLedgerEntry(
  e: { reason: string; ref: string },
  accountOf: (cid: string) => { provider: string; accountId: string } | undefined,
): string {
  if (e.reason === 'usage') {
    const m = /^usage:([^:]+):(\d{4})-(\d{2})-(\d{2})$/.exec(e.ref)
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
