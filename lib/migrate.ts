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
// - 无 schema_version 的库（全新空库 / 框架之前的旧库 / 半建库）一律登记 version=0，从 001 跑起。
//   001 全是 CREATE TABLE IF NOT EXISTS（幂等）：对完整旧库重跑无害、数据不丢；对半建库补全缺表。
//   （不按 contributions 是否存在特判 baseline=1，否则半建库会被误判已迁移、跳过 001。）
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
  {
    version: 3,
    // migration 003（P1b-4）：新增 oauth_snapshots 表，把「授权前 auth-files 文件名快照」按 OAuth
    // state 持久化跨请求。startOAuth 拍快照并存；redirect 的 finishOAuth / device 的 checkOAuth 读同一
    // 份做 findNew 的 before（挡号池既有号，见 cpa.ts findNew 注释③）；成功入库后删、过期清理。
    // 本项目首个「新增功能表」迁移：只 CREATE TABLE 新表，向后兼容——旧代码不用此表也能跑（先加纪律）。
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_snapshots (
          state      TEXT PRIMARY KEY,
          file_names TEXT NOT NULL,   -- 授权前 auth-files 文件名的 JSON 数组
          created_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 4,
    // migration 004（P2a-1）：考察期数据地基。纯新增、向后兼容——
    //   ① 新表 observations：考察期观测事件持久化（发分判定「以系统实际观测并持久化的事件为准」的依据）。
    //   ② contributions 加 5 个考察快照可空列：进考察时冻结窗口 T / 分值 / 规则版本 / 优先级 + 计时起点。
    // 本项目首个用 ALTER TABLE ADD COLUMN 的迁移（002 是重建表）：SQLite 的 ADD COLUMN 只追加可空列，
    //   既不重写已有行、也不改约束，旧代码不读新列即无影响——故非破坏。SQLite 不能一条 ALTER 加多列，一列一条。
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          contribution_id TEXT NOT NULL,
          observed_at    INTEGER NOT NULL,
          kind           TEXT NOT NULL,   -- healthy / hard_fail / soft_fail / unknown
          detail         TEXT NOT NULL DEFAULT '',
          created_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_obs_contrib ON observations(contribution_id);
      `)
      // 考察快照列：都可空＝未进考察时为 null（向后兼容）。一列一条 ALTER ADD COLUMN，不重建表。
      db.exec('ALTER TABLE contributions ADD COLUMN observe_start_at INTEGER')
      db.exec('ALTER TABLE contributions ADD COLUMN observe_window_ms INTEGER')
      db.exec('ALTER TABLE contributions ADD COLUMN snapshot_points INTEGER')
      db.exec('ALTER TABLE contributions ADD COLUMN snapshot_rule_version TEXT')
      db.exec('ALTER TABLE contributions ADD COLUMN snapshot_priority INTEGER')
    },
  },
  {
    version: 5,
    // migration 005（P2a-2，⚠️ 破坏性）：verify_status 值域从旧 7 态迁到需求 §3.2 的 6 态。
    // 只 UPDATE 现有行的值、不改表结构。旧→新映射：
    //   pending→submitted / verifying→first_check / active→granted /
    //   rejected→failed / quarantined→first_check / reauth→needs_review / duplicate→failed
    // ⚠️ quarantined→**first_check**（不是 observing）：quarantined 号从没走过 startObservation，
    //    考察快照列全 NULL；若映射成 observing，processPending 的 settle() 见 observeStartAt==null
    //    直接 return → 号永久卡死（永不启用/发分/判死）。映射回 first_check 让它重走首检、由
    //    enterObservation 冻结快照再进考察，规避无快照的 observing 孤立（codex xhigh review 发现）。
    // 破坏性＝改写既有数据的 verify_status 值域；表结构与行数均不变。
    // 迁移前后行数校验（仿 002）：纯 UPDATE 行数必守恒，此为兜底防意外。
    up(db) {
      const before = (
        db.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }
      ).n
      // 新旧值域不相交（新 6 态无一属旧 7 态），故映射顺序无关、无二次映射，重跑亦幂等。
      const mapping: [string, string][] = [
        ['pending', 'submitted'],
        ['verifying', 'first_check'],
        ['active', 'granted'],
        ['rejected', 'failed'],
        ['quarantined', 'first_check'], // 重走首检记快照，避免无快照的 observing 卡死
        ['reauth', 'needs_review'],
        ['duplicate', 'failed'],
      ]
      const stmt = db.prepare('UPDATE contributions SET verify_status=? WHERE verify_status=?')
      for (const [from, to] of mapping) stmt.run(to, from)
      const after = (
        db.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }
      ).n
      if (after !== before) {
        throw new Error(
          `[migrate 005] 迁移后行数不一致（迁移前 ${before}，迁移后 ${after}），已回滚。`,
        )
      }
    },
  },
  {
    version: 6,
    // migration 006（P2b）：故障顺延（§3.2 不可观测时段暂停考察计时）数据地基。纯新增、向后兼容——
    //   给 contributions 加两列（仿 004 的 ALTER ADD COLUMN，一列一条）：
    //     ① observe_paused_ms —— 累积暂停时长（不可观测时段，不计入考察窗口 T）。null 按 0 处理。
    //     ② last_observed_at  —— 上次**成功观测**时刻，供下轮算观测空洞增量。null＝尚无成功观测。
    //   ADD COLUMN 只追加可空列，不重写已有行、不改约束，旧代码不读新列即无影响——故非破坏。
    up(db) {
      db.exec('ALTER TABLE contributions ADD COLUMN observe_paused_ms INTEGER')
      db.exec('ALTER TABLE contributions ADD COLUMN last_observed_at INTEGER')
      // 回填 in-flight observing 行的 last_observed_at（从最近一次非 unknown 观测时刻）。
      // 否则部署 P2b 时正在考察的号，首次 recordTick 会以 observe_start_at 为基点、把整个部署前
      // 考察窗口误算成停机 → 有效进度重置、发分大延迟。只回填「有观测记录」的行（EXISTS 守卫）；
      // 从没被观测过的 observing 行留 null（首次 tick 以 observe_start_at 兜底，语义正确）。
      db.exec(`
        UPDATE contributions
        SET last_observed_at = (
          SELECT MAX(o.observed_at) FROM observations o
          WHERE o.contribution_id = contributions.id AND o.kind != 'unknown'
        )
        WHERE verify_status = 'observing'
          AND last_observed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM observations o2
            WHERE o2.contribution_id = contributions.id AND o2.kind != 'unknown'
          )
      `)
    },
  },
  {
    version: 7,
    // migration 007（P2-R1，⚠️ 破坏性，换引擎 v4 第一刀）：verify_status 值域从 P2a-2 的 6 态
    // 收敛到需求 §3.2（v4）的 5 态。只 UPDATE 现有行的值、不改表结构（考察快照列 / 暂停列 / observations
    // 表一律留库不删，迁移不可逆）。旧→新映射：
    //   observing→pooled（考察中 → 在池计量）
    //   granted  →pooled（v4「已发分」不再是终态：号持续按量计量，回到在池）
    //   failed   →stopped（已失败 → 已停用）
    //   submitted / first_check / needs_review 不变（故不 UPDATE）
    // 破坏性＝改写既有数据的 verify_status 值域；表结构与行数均不变。
    // 新值（pooled/stopped）与被改的旧值（observing/granted/failed）不相交，故映射顺序无关、重跑幂等
    //   （二次跑旧值已不存在＝no-op）。迁移前后行数校验（仿 002/005）：纯 UPDATE 行数必守恒，兜底防意外。
    up(db) {
      const before = (
        db.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }
      ).n
      // failed 在老 6 态里混了两种来源，v4 语义不同（codex bot 于 PR #15 指出）：
      //   ① 首检就被拒（从未进过考察/池，observe_start_at IS NULL）——v4 规则「首检失败不占唯一键、
      //      可重交」→ 删行释放 (provider, account_id)；
      //   ② 考察中硬失败判死（进过池，observe_start_at 非 null）——占过池 → stopped（锁唯一键）。
      const releasedRow = db
        .prepare(
          "SELECT COUNT(*) AS n FROM contributions WHERE verify_status='failed' AND observe_start_at IS NULL",
        )
        .get() as unknown as { n: number }
      const released = releasedRow.n
      db.exec("DELETE FROM contributions WHERE verify_status='failed' AND observe_start_at IS NULL")
      // observing 且已记 hard_fail 观测的行（v6 worker 判死中途崩溃残留，未走到 failed）＝已知死号，
      // 不能映成 pooled（新 worker 不再扫 pooled 做健康判定，死号会永远挂着）→ 先转 stopped
      // （codex xhigh 于 PR #15 指出）。
      db.exec(`
        UPDATE contributions SET verify_status='stopped'
        WHERE verify_status='observing'
          AND EXISTS (SELECT 1 FROM observations o
                      WHERE o.contribution_id = contributions.id AND o.kind='hard_fail')
      `)
      const mapping: [string, string][] = [
        ['observing', 'pooled'], // 剩余 observing 均无 hard_fail 记录
        ['granted', 'pooled'],
        ['failed', 'stopped'], // 剩余 failed 均进过池
      ]
      const stmt = db.prepare('UPDATE contributions SET verify_status=? WHERE verify_status=?')
      for (const [from, to] of mapping) stmt.run(to, from)
      const after = (
        db.prepare('SELECT COUNT(*) AS n FROM contributions').get() as unknown as { n: number }
      ).n
      // 行数对账：唯一允许的减少 = 被释放的「首检失败未入池」行数
      if (after !== before - released) {
        throw new Error(
          `[migrate 007] 迁移后行数不一致（迁移前 ${before}，释放 ${released}，迁移后 ${after}），已回滚。`,
        )
      }
    },
  },
  {
    version: 8,
    // migration 008（P2-R2）：按日用量结算数据地基。纯新增两表、向后兼容——仿 003/004，只 CREATE 新表，
    // 旧代码不用这两表也能跑。R2 装「按 cpamp 每日调用量折算积分、按日结算」的发分引擎。
    //   ① usage_rates —— 每次调用积分单价（按 provider/套餐分档、后台可配）。points_per_call 用 REAL：
    //      单价可为小数（如 0.1 分/次），结算时 Math.round(次数 × 单价) 落整数积分。老 point_rules（固定
    //      分值表）留库不动、不回滚——本单不触碰它。
    //   ② daily_settlements —— 每号每日一笔结算，UNIQUE(contribution_id, date) 保证同号同日只结一次
    //      （worker 重跑/重启幂等的第一道闸；第二道是 point_ledger 的 UNIQUE(reason, ref)）。
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_rates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider        TEXT NOT NULL,
          plan            TEXT NOT NULL,          -- '*' 为该 provider 的兜底档
          points_per_call REAL NOT NULL,          -- 每次调用积分单价（可小数）
          enabled         INTEGER NOT NULL DEFAULT 1,
          label           TEXT NOT NULL DEFAULT '',
          UNIQUE(provider, plan)
        );

        -- 每号每日结算：一号一日一笔。UNIQUE(contribution_id, date) = 按日结算幂等键。
        CREATE TABLE IF NOT EXISTS daily_settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contribution_id TEXT NOT NULL,
          date            TEXT NOT NULL,           -- 'YYYY-MM-DD' 自然日（时区随服务器）
          provider        TEXT NOT NULL,
          account_id      TEXT NOT NULL,
          call_count      INTEGER NOT NULL,        -- 当日调用次数
          points          INTEGER NOT NULL,        -- 折算积分 = round(call_count × 单价)
          settled_at      INTEGER NOT NULL,
          UNIQUE(contribution_id, date)
        );
        CREATE INDEX IF NOT EXISTS idx_settle_contrib ON daily_settlements(contribution_id);
      `)
    },
  },
  {
    version: 9,
    // migration 009（P2-R3）：首检退回记录表。纯新增、向后兼容——仿 003/008，只 CREATE 新表，
    // 旧代码不用此表也能跑。首检失败（reject）会删掉 contribution 行释放唯一键（§2.4），号随即从
    // dashboard 消失、用户不知为何（§3.2「告知用户登录失败/被封」）。rejections 在删行前后各留一条
    // 中性退回提示，dashboard 据此显示「你交的某号登录失败/被封，未收——修好可重交」。
    //   reason 存**中性人话**（如「登录失败或已被封号」），绝不透传 CPA 报错原文（§8）；
    //   account_id 落库仅供归属/排查，展示侧由 shortAccountLabel 掩码成 provider+短标识，不泄完整敏感号。
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rejections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          linuxdo_id INTEGER NOT NULL,
          provider   TEXT NOT NULL,
          account_id TEXT NOT NULL,
          reason     TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rejections_user ON rejections(linuxdo_id);
      `)
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

// 读起始版本；schema_version 不存在时初始化为 0：
//   全新空库、框架之前的旧库、半建库一律登记 0，由 migrate 主循环从 001 跑起。
//   （不再按 contributions 是否存在特判 baseline=1——那会把「有 contributions 但缺其余
//   baseline 表」的半建库误判为已迁移、跳过 001，随后 seedDefaults 查缺表即抛。）
function startingVersion(db: DatabaseSync): number {
  if (hasTable(db, 'schema_version')) {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as unknown as
      | { version: number }
      | undefined
    return row?.version ?? 0
  }
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  db.prepare(
    'INSERT INTO schema_version (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version)',
  ).run()
  return 0
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
