// 迁移门控探针（部署用）：判断 DB_PATH 的 schema 是否已达代码最新版本。
//   exit 0 = 已最新（含超前/降级场景，视为无需迁移）→ 入口跳过备份；
//   exit 1 = 落后 / 库不存在 / 读取失败（保守）→ 入口先备份再迁移。
// 目的：只在「真有待迁移」时才备份，避免崩溃循环里每次重启都备份，
//   把 BACKUP_KEEP 轮转很快把迁移前那份唯一回滚点挤掉。
// 只读优先（node:sqlite readOnly，已验证可读 live WAL）；读不了再普通开、仅 SELECT，绝不写 PRAGMA。
// 用 Node 26 内置 TS + node:sqlite，无新依赖；复用 lib/migrate.ts 的最新版本和单行版本读取逻辑。
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { LATEST_VERSION, readSchemaVersion } from '../lib/migrate.ts'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db') // 与 lib/db.ts、scripts/migrate.ts 一致

// 读 schema_version.version；表不存在/空表按 0。只读优先，开不了再普通开（都只 SELECT）。
function readVersion(dbPath: string): number {
  let lastErr: unknown
  for (const opts of [{ readOnly: true }, {}]) {
    try {
      const db = new DatabaseSync(dbPath, opts)
      try {
        return readSchemaVersion(db) ?? 0
      } finally {
        db.close()
      }
    } catch (e) {
      lastErr = e // 只读开失败（如 -shm 不可建）→ 回退普通开
    }
  }
  throw lastErr
}

if (!fs.existsSync(DB_PATH)) {
  console.log(`[schema-check] 库不存在（${DB_PATH}），视为需迁移`)
  process.exit(1)
}

try {
  const version = readVersion(DB_PATH)
  if (version >= LATEST_VERSION) {
    console.log(`[schema-check] 当前 v${version} ≥ 最新 v${LATEST_VERSION}：已最新，跳过备份`)
    process.exit(0)
  }
  console.log(`[schema-check] 当前 v${version} < 最新 v${LATEST_VERSION}：需迁移`)
  process.exit(1)
} catch (e) {
  console.log(`[schema-check] 读版本失败，保守视为需迁移：${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
