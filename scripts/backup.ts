// 独立备份入口：VACUUM INTO 产出 WAL 安全的一致性快照，并按保留策略清理旧份。
// 运行：`npm run backup`。env：DB_PATH（默认 data/app.db）、BACKUP_DIR（默认 data/backups）、
// BACKUP_KEEP（默认 7）。用 Node 26 内置 TS + node:sqlite，无新依赖。
import path from 'node:path'
import { backupDb, parseBackupKeep } from '../lib/backup.ts'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'data', 'backups')
const BACKUP_KEEP = parseBackupKeep(process.env.BACKUP_KEEP)

const file = backupDb(DB_PATH, BACKUP_DIR, BACKUP_KEEP)
console.log(`[backup] 完成：${file}（目录 ${BACKUP_DIR}，保留最新 ${BACKUP_KEEP} 份）`)
