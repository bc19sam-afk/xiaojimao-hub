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
// now 注入以可测；更要紧的是让**判定时刻与命名时刻同源**（见 dailyBackupIfDue）：若命名各取各的
// 时钟，日界前一瞬判定通过、命名却落到次日，次日会被 latestBackupDay 判成「已备过」而整天不备。
export function backupDb(dbPath: string, backupDir: string, keep: number, now: Date = new Date()): string {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep 必须是 >=1 的整数，得到：${keep}`)
  // SQLite 打开不存在的路径会静默建空库——备份工具必须先确认源库存在
  if (!fs.existsSync(dbPath)) throw new Error(`源库不存在：${dbPath}`)
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })

  // 时间戳到秒 + 短随机后缀：VACUUM INTO 目标已存在会报错，随机后缀防同秒撞名
  const ts = now.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
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

// ============================================================================
// 每日自动备份（P6-R2）
//
// 动机：升级期备份（entrypoint，见 §5.1）只在「有待迁移」时才跑——不升级的日子，上次升级以来的
// 数据没有任何快照。worker 每天补一份本地快照兜底。
//
// 🔴 防 churn 纪律（P6-R1 拿三轮修复换来的）：restart:unless-stopped 下崩溃循环会反复重启进程，
//    「是否该备份」的判据**必须落在磁盘上**（解析已有备份文件名），不能只靠进程内存标记——
//    否则每次重启都以为「今天还没备过」，一天备出上百份，把 BACKUP_KEEP 轮转集冲垮。
// ============================================================================

// 从备份文件名解析出它属于哪个**服务器本地自然日**（'YYYY-MM-DD'），解析不出返回 null。
//
// ⚠️ 时区换算（不能省）：backupDb 的文件名时间戳来自 toISOString()＝**UTC**，而日切判定用的是
//    本地日（与 lib/settle.ts 的 dayStr 同口径，TZ=Asia/Shanghai）。若直接截文件名前 10 字符当本地日，
//    东八区 00:00–08:00 这 8 小时里「今天的备份」文件名还写着昨天的 UTC 日期 → 恒判「今天没备过」
//    → 每个 tick 备一份，正是上面那条纪律要防的 churn。故先把文件名还原成 UTC 瞬时，再取本地日。
function backupLocalDay(fileName: string): string | null {
  // backup-2026-07-26T14-30-05-a1b2c3.db → 前面是 ISO 到秒（冒号已换成连字符），后面是 6 位随机
  const m = /^backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-[0-9a-f]+\.db$/.exec(fileName)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
  if (Number.isNaN(ms)) return null
  return localDayStr(new Date(ms))
}

// Date → 服务器本地自然日 'YYYY-MM-DD'（与 lib/settle.ts 的 dayStr 同口径：本地 getter，非 UTC）
function localDayStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 目录里最近一份备份所属的本地日（'YYYY-MM-DD'），没有任何可识别备份则 null。
// 只认 backup-*.db（与 BACKUP_KEEP 轮转集同一命名口径）：preupgrade.db / pre-restore.db（钉住的
// 回滚点，故意不进轮转集）与任何垃圾文件一律忽略——它们不代表「今天做过日常备份」。
// 目录不存在 = 从没备过 → null（不抛，首次部署即此情形）。
export function latestBackupDay(dir: string): string | null {
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return null
  }
  let latest: string | null = null
  for (const f of files) {
    const day = backupLocalDay(f)
    if (day !== null && (latest === null || day > latest)) latest = day // 'YYYY-MM-DD' 定长，字典序即日序
  }
  return latest
}

// 当天（now 所在的服务器本地自然日）若尚无备份 → 备一份并返回 true；已有则跳过返回 false。
// now 注入以可测（跨日判定确定性）；调用方传真实时钟。
// 备份本身失败会照常抛出，由调用方（worker 第四段）捕获记日志——绝不静默吞掉备份失败。
export function dailyBackupIfDue(now: Date, dbPath: string, dir: string, keep: number): boolean {
  const today = localDayStr(now)
  const latest = latestBackupDay(dir)
  if (latest !== null && latest >= today) return false // >= 而非 ===：时钟回拨时也不重复备
  backupDb(dbPath, dir, keep, now) // 传同一个 now：命名与判定同源，日界前后不会互相错位
  return true
}
