import { DatabaseSync } from 'node:sqlite'

// ============================================================================
// 版本化迁移框架（P0-B-1）
//
// - schema_version：单行记录已应用的迁移版本。
// - migrate(db)：读当前版本，按序跑未应用的迁移；每个迁移单事务
//   （BEGIN IMMEDIATE 兼作迁移锁防并发），成功后更新版本；重复调用幂等。
//   拿锁后会重读版本——锁外读到的版本可能已过期（另一进程刚应用完同一迁移），
//   重读发现已应用则跳过，防止双重执行（对未来的破坏性迁移是硬保护）。
// - baseline 001：把框架之前 openDb() 里的建表原样固化。全新库与旧库走同一迁移链。
// - 无版本旧库认定：没有 schema_version 但已存在 contributions（框架之前建的旧库）
//   → 认定 baseline 001 已应用，只登记 version=1、不重跑建表；全新空库则从 0 正常跑 001。
//
// 后续加迁移：往 migrations 追加 { version: 2, up(db) {...} }（含"重建表模式"改约束，属 P1a）。
// ============================================================================

export interface Migration {
  version: number
  up(db: DatabaseSync): void
}

export const migrations: Migration[] = [
  {
    version: 1,
    // baseline 001：与迁移框架之前 openDb() 里的建表一字不差（schema 不在本任务改动）
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contributions (
          id            TEXT PRIMARY KEY,
          linuxdo_id    INTEGER NOT NULL,
          username      TEXT NOT NULL,
          account_id    TEXT NOT NULL UNIQUE,
          email         TEXT NOT NULL,
          provider      TEXT NOT NULL DEFAULT 'codex',
          plan          TEXT NOT NULL,
          method        TEXT NOT NULL,
          auth_file_name TEXT NOT NULL,
          verify_status TEXT NOT NULL,
          points        INTEGER NOT NULL DEFAULT 0,
          reward_status TEXT NOT NULL,
          reward_text   TEXT NOT NULL DEFAULT '',
          reward_note   TEXT NOT NULL DEFAULT '',
          reward_code   TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contrib_user   ON contributions(linuxdo_id);
        CREATE INDEX IF NOT EXISTS idx_contrib_verify ON contributions(verify_status);

        -- 全局键值配置（管理页可改）
        CREATE TABLE IF NOT EXISTS app_config (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
        );

        -- 发分规则：(provider, plan) → 积分。plan='*' 为该 provider 的兜底
        CREATE TABLE IF NOT EXISTS point_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          plan     TEXT NOT NULL,
          points   INTEGER NOT NULL,
          enabled  INTEGER NOT NULL DEFAULT 1,
          label    TEXT NOT NULL DEFAULT '',
          UNIQUE(provider, plan)
        );

        -- 兑换项（商店）
        CREATE TABLE IF NOT EXISTS redeem_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          cost        INTEGER NOT NULL,
          kind        TEXT NOT NULL,           -- permanent_quota/timed_quota/vip/invite_code
          enabled     INTEGER NOT NULL DEFAULT 1,
          sort        INTEGER NOT NULL DEFAULT 0,
          config      TEXT NOT NULL DEFAULT '{}'
        );

        -- 积分流水（余额 = SUM(delta)）。UNIQUE(reason,ref) 保证同一贡献只发一次分
        CREATE TABLE IF NOT EXISTS point_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          linuxdo_id INTEGER NOT NULL,
          delta      INTEGER NOT NULL,
          reason     TEXT NOT NULL,
          ref        TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          UNIQUE(reason, ref)
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_user ON point_ledger(linuxdo_id);

        -- 兑换记录
        CREATE TABLE IF NOT EXISTS redemptions (
          id TEXT PRIMARY KEY,
          linuxdo_id INTEGER NOT NULL,
          item_id    INTEGER NOT NULL,
          item_name  TEXT NOT NULL,
          cost       INTEGER NOT NULL,
          status     TEXT NOT NULL,            -- pending/fulfilled/failed
          result     TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(linuxdo_id);
      `)
    },
  },
  {
    version: 2,
    // migration 002（P1a）：contributions 唯一键 account_id → 复合 UNIQUE(provider, account_id)。
    // 三 provider（codex/claude/grok）的 account_id 命名空间独立，不同 provider 撞同一 id 不算重复。
    // SQLite 不能用 ALTER 删/换 UNIQUE，用「重建表模式」：建新表 → 校验并复制 → 删旧表 → 改名 → 重建索引。
    // 全程在 migrate() 提供的外层事务内（SQLite 的 DDL 可随事务回滚），up() 内不自开事务。
    up(db) {
      // 1) 复制前校验：若已存在重复 (provider, account_id) 对则拒绝迁移，绝不静默丢行
      const dups = db
        .prepare(
          `SELECT provider, account_id, COUNT(*) AS c
           FROM contributions GROUP BY provider, account_id HAVING c > 1`,
        )
        .all() as unknown as { provider: string; account_id: string; c: number }[]
      if (dups.length > 0) {
        const list = dups.map((d) => `(${d.provider}, ${d.account_id})×${d.c}`).join('; ')
        throw new Error(
          `[migrate 002] contributions 存在重复的 (provider, account_id)：${list}。` +
            `迁移到复合唯一键前请人工清理这些重复行，再重跑 npm run migrate。`,
        )
      }
      // 迁移前行数，迁移后须一致（防静默丢行）
      const before = (
        db.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }
      ).n

      // 2) 建新表：列结构与 baseline 001 一字不差，唯一改动 = 去掉 account_id 列级 UNIQUE，
      //    改为表级 UNIQUE(provider, account_id)
      db.exec(`
        CREATE TABLE contributions_new (
          id            TEXT PRIMARY KEY,
          linuxdo_id    INTEGER NOT NULL,
          username      TEXT NOT NULL,
          account_id    TEXT NOT NULL,
          email         TEXT NOT NULL,
          provider      TEXT NOT NULL DEFAULT 'codex',
          plan          TEXT NOT NULL,
          method        TEXT NOT NULL,
          auth_file_name TEXT NOT NULL,
          verify_status TEXT NOT NULL,
          points        INTEGER NOT NULL DEFAULT 0,
          reward_status TEXT NOT NULL,
          reward_text   TEXT NOT NULL DEFAULT '',
          reward_note   TEXT NOT NULL DEFAULT '',
          reward_code   TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          UNIQUE(provider, account_id)
        );
      `)

      // 3) 复制数据（显式列清单，不用 SELECT *）
      db.exec(`
        INSERT INTO contributions_new
          (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
           verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at)
        SELECT
          id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
          verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at
        FROM contributions;
      `)

      // 4) 删旧表 → 改名（旧表两索引随 DROP 一并消失）
      db.exec('DROP TABLE contributions')
      db.exec('ALTER TABLE contributions_new RENAME TO contributions')

      // 5) 重建索引（与 baseline 001 同名同义）
      db.exec('CREATE INDEX IF NOT EXISTS idx_contrib_user   ON contributions(linuxdo_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_contrib_verify ON contributions(verify_status)')

      // 6) 迁移后行数校验：与迁移前不等即抛，外层事务回滚
      const after = (
        db.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }
      ).n
      if (after !== before) {
        throw new Error(
          `[migrate 002] 迁移后行数不一致（迁移前 ${before}，迁移后 ${after}），已回滚。`,
        )
      }
    },
  },
]

// 代码所知的最新 schema 版本（从 migrations 数组派生，勿手写）
export const LATEST_VERSION = Math.max(...migrations.map((m) => m.version))

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name)
}

// 迁移执行纪律守卫（P1-0）：生产启动只校验 schema 版本，不执行迁移
// （迁移是部署时的独立步骤 `npm run migrate`）。纯只读，不建 schema_version 表：
//   无 schema_version 表（含全新空库）视为版本 0；
//   落后于 LATEST_VERSION → throw，指引先跑 npm run migrate；
//   相等 → 通过；
//   超前（DB 版本 > 代码版本，如代码回滚）→ warn 放行（迁移纪律「先加后删」向后兼容）。
export function assertSchemaCurrent(db: DatabaseSync): void {
  let version = 0
  if (hasTable(db, 'schema_version')) {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as unknown as
      | { version: number }
      | undefined
    version = row?.version ?? 0
  }
  if (version < LATEST_VERSION) {
    throw new Error(
      `[db] schema 版本落后（当前 ${version}，代码需要 ${LATEST_VERSION}）：请先运行 npm run migrate 完成迁移，再启动应用。`,
    )
  }
  if (version > LATEST_VERSION) {
    console.warn(
      `[db] schema 版本超前（当前 ${version}，代码 ${LATEST_VERSION}）：疑似代码回滚，按向后兼容放行。`,
    )
  }
}

// 读起始版本；schema_version 不存在时初始化：
//   已有 contributions 的旧库 → 认定 baseline 已应用(1)；全新空库 → 0。
function startingVersion(db: DatabaseSync): number {
  if (hasTable(db, 'schema_version')) {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as unknown as
      | { version: number }
      | undefined
    return row?.version ?? 0
  }
  const baseline = hasTable(db, 'contributions') ? 1 : 0
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  db.prepare(
    'INSERT INTO schema_version (version) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM schema_version)',
  ).run(baseline)
  return baseline
}

// 应用所有未应用迁移（按 version 升序），返回最终版本。重复调用幂等。
export function migrate(db: DatabaseSync): number {
  let version = startingVersion(db)
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= version) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      // 拿锁后重读版本：锁外读到的可能已过期（并发进程刚应用完此迁移）
      const cur = (
        db.prepare('SELECT version FROM schema_version LIMIT 1').get() as unknown as
          | { version: number }
          | undefined
      )?.version ?? 0
      if (m.version <= cur) {
        db.exec('ROLLBACK')
        version = cur
        continue
      }
      m.up(db)
      db.prepare('UPDATE schema_version SET version = ?').run(m.version)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    version = m.version
  }
  return version
}
