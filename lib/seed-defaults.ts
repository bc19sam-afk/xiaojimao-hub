import type { DatabaseSync } from 'node:sqlite'

// 业务默认值只能由显式 bootstrap/migration 调用。数据库连接与 readiness 都不得隐式播种，
// 否则一个未鉴权探针请求就会持久化管理员可见的业务配置。
export function seedDefaults(
  db: DatabaseSync,
  mock = (process.env.MOCK ?? 'true') !== 'false',
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const ruleCount = (db.prepare('SELECT COUNT(*) AS n FROM point_rules').get() as { n: number }).n
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
      const statement = db.prepare(
        'INSERT INTO point_rules (provider, plan, points, label) VALUES (?,?,?,?)',
      )
      for (const [provider, plan, points, label] of rules) {
        statement.run(provider, plan, points, label)
      }
    }

    if (db.prepare('SELECT 1 FROM app_config WHERE key=?').get('usage_rates_seeded') == null) {
      const rateCount = (db.prepare('SELECT COUNT(*) AS n FROM usage_rates').get() as { n: number }).n
      if (rateCount === 0) {
        const rates: [string, string, number, string][] = [
          ['codex', 'plus', 1, 'Codex Plus 每次调用'],
          ['codex', 'pro', 2, 'Codex Pro 每次调用'],
          ['codex', '*', 1, 'Codex 其它每次调用'],
          ['claude', '*', 1, 'Claude 每次调用'],
          ['grok', '*', 1, 'SuperGrok 每次调用'],
        ]
        const statement = db.prepare(
          `INSERT INTO usage_rates (provider, plan, points_per_call, label) VALUES (?,?,?,?)
           ON CONFLICT(provider, plan) DO NOTHING`,
        )
        for (const [provider, plan, pointsPerCall, label] of rates) {
          statement.run(provider, plan, pointsPerCall, label)
        }
      }
      db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)').run(
        'usage_rates_seeded',
        '1',
        Date.now(),
      )
    }

    const itemCount = (db.prepare('SELECT COUNT(*) AS n FROM redeem_items').get() as { n: number }).n
    if (itemCount === 0) {
      const items: [string, string, number, string, number][] = [
        ['限时额度（高）', '较高额度，限时使用', 50, 'timed_quota', 1],
        ['永久额度', '永久有效的额度', 100, 'permanent_quota', 2],
        ['注册邀请码', '公益站注册邀请码 ×1', 150, 'invite_code', 3],
        ['订阅 VIP', '一段时间的 VIP 订阅', 200, 'vip', 4],
      ]
      const statement = db.prepare(
        'INSERT INTO redeem_items (name, description, cost, kind, sort) VALUES (?,?,?,?,?)',
      )
      for (const [name, description, cost, kind, sort] of items) {
        statement.run(name, description, cost, kind, sort)
      }
    }

    if (db.prepare('SELECT 1 FROM app_config WHERE key=?').get('observe_window_ms') == null) {
      db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)').run(
        'observe_window_ms',
        String(mock ? 8000 : 86_400_000),
        Date.now(),
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
