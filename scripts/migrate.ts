// 独立迁移入口（部署用）：打开 data/app.db，跑迁移链，打印当前 schema 版本。
// 运行：`npm run migrate`。用 Node 26 内置 TS + node:sqlite，无新依赖。
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { migrate } from '../lib/migrate.ts'
import { seedDefaults } from '../lib/seed-defaults.ts'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db') // 认 DB_PATH env（与 lib/db.ts、scripts/backup.ts 一致）

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 5000')
const version = migrate(db)
seedDefaults(db)
db.close()
console.log(`[migrate] 完成，当前 schema 版本：${version}`)
