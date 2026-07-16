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
  // pending 待巡检 / verifying 巡检中 / active 已入池 / rejected 淘汰 /
  // duplicate 重复 / quarantined 隔离复检 / reauth 需重新授权
  verifyStatus:
    | 'pending'
    | 'verifying'
    | 'active'
    | 'rejected'
    | 'duplicate'
    | 'quarantined'
    | 'reauth'
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
}

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')

function openDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const d = new DatabaseSync(DB_PATH)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA busy_timeout = 5000')
  // 迁移纪律：生产（非 mock）只校验 schema 版本，迁移由部署步骤 `npm run migrate` 执行；
  // mock（开发/演示）保持启动自动迁移。
  if (env.mock) migrate(d)
  else assertSchemaCurrent(d)
  seedDefaults(d)
  return d
}

// 首次运行播种合理默认值（管理页可随时改）。仅在表为空时插入。
function seedDefaults(d: DatabaseSync): void {
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
  }
}

// 考察期观测事件（P2a-1）：一行=一次观测。kind 见 observations.kind 列注释（healthy/hard_fail/soft_fail/unknown）
export interface Observation {
  id: number
  contributionId: string
  observedAt: number
  kind: string
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
    kind: r.kind,
    detail: r.detail,
    createdAt: r.created_at,
  }
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

  leaderboard(limit = 20): { linuxdoId: number; username: string; count: number }[] {
    return conn
      .prepare(
        `SELECT linuxdo_id AS linuxdoId, username, COUNT(*) AS count
         FROM contributions WHERE verify_status = 'active'
         GROUP BY linuxdo_id ORDER BY count DESC, MIN(created_at) ASC LIMIT ?`,
      )
      .all(limit) as unknown as { linuxdoId: number; username: string; count: number }[]
  },

  // 我的排名与入池数（用于榜单外也能看到自己的名次）
  myRank(linuxdoId: number): { rank: number; count: number } {
    const mine = conn
      .prepare(
        `SELECT COUNT(*) AS count FROM contributions
         WHERE verify_status = 'active' AND linuxdo_id = ?`,
      )
      .get(linuxdoId) as unknown as { count: number }
    const count = mine?.count ?? 0
    if (count === 0) return { rank: 0, count: 0 }
    // 排名 = 入池数比我多的人数 + 1
    const ahead = conn
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT linuxdo_id, COUNT(*) AS c FROM contributions
           WHERE verify_status = 'active' GROUP BY linuxdo_id HAVING c > ?
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
    const sql = `SELECT id, name, description, cost, kind, enabled, sort, config FROM redeem_items ${
      onlyEnabled ? 'WHERE enabled=1' : ''
    } ORDER BY sort, cost`
    return conn.prepare(sql).all() as unknown as RedeemItem[]
  },
  getRedeemItem(id: number): RedeemItem | undefined {
    return conn
      .prepare('SELECT id, name, description, cost, kind, enabled, sort, config FROM redeem_items WHERE id=?')
      .get(id) as unknown as RedeemItem | undefined
  },
  upsertRedeemItem(it: {
    id?: number
    name: string
    description: string
    cost: number
    kind: string
    enabled: boolean
    sort: number
    config?: string
  }): void {
    if (it.id) {
      conn
        .prepare(
          'UPDATE redeem_items SET name=?, description=?, cost=?, kind=?, enabled=?, sort=?, config=? WHERE id=?',
        )
        .run(it.name, it.description, it.cost, it.kind, it.enabled ? 1 : 0, it.sort, it.config ?? '{}', it.id)
    } else {
      conn
        .prepare('INSERT INTO redeem_items (name, description, cost, kind, enabled, sort, config) VALUES (?,?,?,?,?,?,?)')
        .run(it.name, it.description, it.cost, it.kind, it.enabled ? 1 : 0, it.sort, it.config ?? '{}')
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

  // ===== 考察期观测事件（P2a-1）=====
  // 纯 CRUD，不含任何状态转移/发分/计时判断（那是 P2a-2/P2b）。
  // 本单只建数据层：暂无写入方——P2b/P2c 巡检时才调 addObservation；此处测试直接驱动。
  addObservation(contributionId: string, kind: string, detail = ''): void {
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
  // 进入考察：记 observe_start_at=now（计时起点）+ 冻结窗口/分值/规则版本/优先级四列。纯写，不做任何决策。
  startObservation(
    contributionId: string,
    snap: { windowMs: number; points: number; ruleVersion: string; priority: number },
  ): void {
    const now = Date.now()
    conn
      .prepare(
        `UPDATE contributions
         SET observe_start_at=?, observe_window_ms=?, snapshot_points=?,
             snapshot_rule_version=?, snapshot_priority=?, updated_at=?
         WHERE id=?`,
      )
      .run(now, snap.windowMs, snap.points, snap.ruleVersion, snap.priority, now, contributionId)
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
  kind: string
  enabled: number
  sort: number
  config: string
}
export interface RedemptionRow {
  id: string
  itemName: string
  cost: number
  status: string
  result: string
  createdAt: number
}
