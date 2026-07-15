import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ============================================================================
// WAL 安全一致性备份（P0-B-3）
//
// 库跑在 WAL 模式：裸 cp app.db 会丢 app.db-wal 里未 checkpoint 的数据。
// VACUUM INTO 在普通读事务里读穿 main+WAL，产出单文件一致性快照，
// 对源库只读、不打断在线写入。
// ============================================================================

const BACKUP_RE = /^backup-.*\.db$/

// 备份 dbPath 到 backupDir/backup-<时间戳到秒>-<随机>.db（权限 0600），
// 并按 keep 只保留最新 keep 份（仅清理匹配命名模式的文件）。返回备份文件绝对路径。
export function backupDb(dbPath: string, backupDir: string, keep: number): string {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep 必须是 >=1 的整数，得到：${keep}`)
  // SQLite 打开不存在的路径会静默建空库——备份工具必须先确认源库存在
  if (!fs.existsSync(dbPath)) throw new Error(`源库不存在：${dbPath}`)
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })

  // 时间戳到秒 + 短随机后缀：VACUUM INTO 目标已存在会报错，随机后缀防同秒撞名
  const ts = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const rand = crypto.randomBytes(3).toString('hex')
  const target = path.resolve(backupDir, `backup-${ts}-${rand}.db`)

  const src = new DatabaseSync(dbPath)
  try {
    src.exec('PRAGMA busy_timeout = 5000')
    try {
      src.prepare('VACUUM INTO ?').run(target)
    } catch (err) {
      fs.rmSync(target, { force: true }) // 失败时 VACUUM INTO 可能留下残缺目标文件
      throw err
    }
  } finally {
    src.close()
  }
  fs.chmodSync(target, 0o600)

  // 保留策略：刚产出的这份必留，其余按 mtime 新→旧排序再留 keep-1 份，更旧的删掉
  const others = fs
    .readdirSync(backupDir)
    .filter((f) => BACKUP_RE.test(f))
    .map((f) => path.resolve(backupDir, f))
    .filter((p) => p !== target)
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const old of others.slice(keep - 1)) fs.rmSync(old.p, { force: true })

  return target
}
