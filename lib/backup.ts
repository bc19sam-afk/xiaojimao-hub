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

// ============================================================================
// 跨进程发布锁（P6-R2 复审三轮第 5 条）
//
// 缺它的后果是**丢光备份**：手动 `npm run backup` 与 worker 每日备份是两个进程，各自跑完
// VACUUM 后都执行「留自己 + 按 mtime 留 keep-1 份」。`BACKUP_KEEP=1` 时 `slice(0)` ＝删掉
// 除自己以外的**全部**——两进程交错就互相删掉对方刚发布的那份，两次调用都返回成功路径，
// 备份目录却是空的（复审实测：并发 6 轮有 2 轮剩 0 份）。keep>=2 时同样会少留。
//
// 锁的载体用 SQLite 自己：`BEGIN IMMEDIATE` 拿的是文件级 RESERVED 写锁，跨进程互斥（实测另一
// 进程被挡满 busy_timeout），且**持锁进程被 SIGKILL 后由内核释放 fd 自动解锁**（实测等待 0ms
// 即可拿到）——不会像「创建标记文件当锁」那样留下永久锁死的僵尸锁。无新依赖。
//
// ⚠️ 临界区只包「发布 + 轮转」，**不包 VACUUM**：VACUUM 写的是各自唯一命名的 .tmp- 文件，
//    互不干扰；而它是同步调用、大库要几百毫秒（见 worker.ts 的说明），包进锁里会让第二个进程
//    的事件循环白白多阻塞一整个 VACUUM 的时长。临界区里只有 rename + readdir + unlink，微秒级。
// ⚠️ 拿不到锁就抛错（fail-closed）：临界区不含任何可能卡住的操作，超时说明现场真出了异常，
//    这时宁可报「备份失败」也不能绕过锁去轮转——那正是本条要修的数据丢失。
const LOCK_FILE = '.backup.lock'
const LOCK_TIMEOUT_MS = 10_000

function withPublishLock<T>(backupDir: string, fn: () => T): T {
  const lock = new DatabaseSync(path.resolve(backupDir, LOCK_FILE))
  try {
    lock.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MS}`)
    try {
      lock.exec('BEGIN IMMEDIATE')
    } catch (err) {
      throw new Error(
        `备份发布锁获取超时（${LOCK_TIMEOUT_MS}ms）：${path.resolve(backupDir, LOCK_FILE)}。` +
          `临界区只做 rename/轮转（微秒级），超时说明现场异常，已中止本次备份。原因：${err}`,
      )
    }
    return fn()
  } finally {
    lock.close() // 事务未提交时 close 即回滚并释放锁；进程被杀则由内核释放
  }
}

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

  // 🔴 原子发布（P6-R2 复审必修 2）：先写**不匹配 BACKUP_RE 的临时名**，VACUUM 全程成功后才
  //    rename 成 backup-*.db。若直接写最终名，VACUUM 中途断电/进程被杀会留下一个「有 SQLite 头
  //    但内容截断」的 backup-*.db——它同时污染两条判据：latestBackupDay 认它是「今天已备过」
  //    → 整天不再备份；BACKUP_KEEP 轮转集也认它 → 占一个名额把真好备份挤出去。两条都是静默的。
  //    rename 同目录内是原子的（不跨设备），故不存在「改到一半的文件名」。
  //    临时名以 `.tmp-` 打头：既不匹配 BACKUP_RE（不进轮转集），也不匹配 backupLocalDay 的文件名
  //    模式（不被当成「今天备过了」）——残缺产物再也影响不了任何判据。
  //    ⚠️ 遗留清理：VACUUM 抛错（磁盘满等）由下面 catch 删掉临时文件，发布阶段抛错（拿不到锁等）
  //    由 withPublishLock 外层的 catch 删（见下）；只有**硬杀**（SIGKILL/断电）会留下一个
  //    .tmp-backup-*.db。它无害（不进任何判据），手动删即可。故意不自动清扫同目录的
  //    .tmp-*：手动 `scripts/backup.ts` 与 worker 的每日备份是两个进程，扫一遍会误删对方正在写的那份。
  const tmp = path.resolve(backupDir, `.tmp-backup-${ts}-${rand}.db`)

  const src = new DatabaseSync(dbPath)
  try {
    src.exec('PRAGMA busy_timeout = 5000')
    try {
      src.prepare('VACUUM INTO ?').run(tmp)
    } catch (err) {
      fs.rmSync(tmp, { force: true }) // 失败时 VACUUM INTO 可能留下残缺目标文件
      throw err
    }
  } finally {
    src.close()
  }
  fs.chmodSync(tmp, 0o600) // 先收权限再改名：发布出去的那一刻权限已经是 0600，没有 0644 的窗口

  // 🔴 R6-P2④（codex R5 终审）：发布锁失败时清理临时文件。
  //
  //    VACUUM 成功 → tmp 已落盘 0600；接下来 withPublishLock 拿锁超时或 rename 失败（磁盘满等）
  //    会抛错。修复前这里没 catch，tmp 留在目录里**占着磁盘空间**却不会被任何判据识别（不匹配
  //    BACKUP_RE，轮转集看不见；不进 latestBackupDay）→ 只能手动清。
  //    故发布锁失败路径也做 force:true 清理（同 VACUUM catch 一致）：操作已中止、产物不可用、留着无益。
  //    ⚠️ 硬杀（SIGKILL/断电）仍会留 tmp——内核不给进程善终机会，无法从 JS 层清理。它是无害残留。
  // 🔴 发布 + 轮转必须在同一把跨进程锁内（见上面 withPublishLock）：rename 与「按 mtime 留 keep-1」
  //    之间若被另一个进程插进来发布，两边的 readdir 都看不到对方那份，就会各自把对方删掉。
  //    锁内先 rename 再 readdir，保证「读到的目录内容」与「自己已发布」是同一个瞬间的视图。
  try {
    withPublishLock(backupDir, () => {
      fs.renameSync(tmp, target)

      // 保留策略：刚产出的这份必留，其余按 mtime 新→旧排序再留 keep-1 份，更旧的删掉
      const others = fs
        .readdirSync(backupDir)
        .filter((f) => BACKUP_RE.test(f))
        .map((f) => path.resolve(backupDir, f))
        .filter((p) => p !== target)
        .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const old of others.slice(keep - 1)) fs.rmSync(old.p, { force: true })
    })
  } catch (err) {
    fs.rmSync(tmp, { force: true }) // 发布失败，临时文件不再需要
    throw err
  }

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
