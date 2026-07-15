import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { migrate } from './migrate'

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
}

const DB_PATH = path.join(process.cwd(), 'data', 'app.db')

function openDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const d = new DatabaseSync(DB_PATH)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA busy_timeout = 5000')
  migrate(d)
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
  }
}

export const db = {
  all(): Contribution[] {
    return (conn.prepare('SELECT * FROM contributions').all() as unknown as Row[]).map(toContribution)
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

  // 插入；account_id 冲突则不插入并返回 duplicate=true（依赖 UNIQUE 约束，原子防重）
  insertUnique(c: Contribution): { duplicate: boolean } {
    const r = conn
      .prepare(
        `INSERT INTO contributions
         (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
          verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id) DO NOTHING`,
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
