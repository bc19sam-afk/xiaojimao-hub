import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  BACKUP_MANIFEST_METHOD,
  BACKUP_MANIFEST_VERSION,
  type BackupManifest,
  backupManifestPath,
  isCompleteBackupPair,
  sha256File,
  verifyBackupPair,
} from './backup-manifest.ts'

// ============================================================================
// WAL 安全一致性备份（P0-B-3）
//
// 库跑在 WAL 模式：裸 cp app.db 会丢 app.db-wal 里未 checkpoint 的数据。
// VACUUM INTO 在普通读事务里读穿 main+WAL，产出单文件一致性快照，
// 对源库只读、不打断在线写入。
// ============================================================================

const BACKUP_RE = /^backup-.*\.db$/
const DEFAULT_BACKUP_KEEP = 7

function assertSafeManifestName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error(`备份文件名异常：${JSON.stringify(name)}`)
  }
}

function writeControlledBackupManifest(
  snapshotPath: string,
  manifestPath: string,
  name: string,
): BackupManifest {
  assertSafeManifestName(name)
  const snapshotStat = fs.lstatSync(snapshotPath)
  if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink() || (snapshotStat.mode & 0o777) !== 0o600) {
    throw new Error(`快照必须是 0600 regular file：${snapshotPath}`)
  }
  const manifest: BackupManifest = {
    version: BACKUP_MANIFEST_VERSION,
    method: BACKUP_MANIFEST_METHOD,
    name,
    size: snapshotStat.size,
    sha256: sha256File(snapshotPath),
  }
  const payload = `${JSON.stringify(manifest)}\n`
  const fd = fs.openSync(manifestPath, 'wx', 0o600)
  const created = fs.fstatSync(fd)
  let failure: unknown
  try {
    fs.writeFileSync(fd, payload, { encoding: 'utf8' })
    fs.fchmodSync(fd, 0o600)
  } catch (error) {
    failure = error
  }
  try {
    fs.closeSync(fd)
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) {
    try {
      const current = fs.lstatSync(manifestPath)
      if (current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(manifestPath)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([failure, cleanupError], `manifest 写入失败且无法清理：${manifestPath}`)
      }
    }
    throw failure
  }
  return manifest
}

function lstatIfExists(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function removeOwnedFile(filePath: string, owned: fs.Stats): void {
  const current = fs.lstatSync(filePath)
  if (current.dev !== owned.dev || current.ino !== owned.ino) {
    throw new Error(`pin rollback 拒绝删除所有权已漂移的文件：${filePath}`)
  }
  fs.unlinkSync(filePath)
}

// 手动备份与 worker 自动备份共用同一严格解析器。仅“未配置/空字符串”使用默认 7；任何非空脏值
// 都必须在 VACUUM、发布锁与轮转之前失败，绝不能 parseInt 截断或静默回退后删除既有备份。
export function parseBackupKeep(raw: string | undefined): number {
  if (raw == null || raw === '') return DEFAULT_BACKUP_KEEP
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`BACKUP_KEEP 必须是 >=1 的十进制整数，得到：${JSON.stringify(raw)}`)
  }
  const keep = Number(raw)
  if (!Number.isSafeInteger(keep)) {
    throw new Error(`BACKUP_KEEP 必须是安全整数，得到：${JSON.stringify(raw)}`)
  }
  return keep
}

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

export function withBackupPublishLock<T>(backupDir: string, fn: () => T): T {
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

export function pinBackupPair(sourcePath: string, targetPath: string): void {
  const source = path.resolve(sourcePath)
  const target = path.resolve(targetPath)
  if (source === target || path.dirname(source) !== path.dirname(target)) {
    throw new Error('pin 只允许同一备份目录内的 pair 改名')
  }
  const sourceManifest = backupManifestPath(source)
  const targetManifest = backupManifestPath(target)

  withBackupPublishLock(path.dirname(source), () => {
    const sourcePair = verifyBackupPair(source, sourceManifest, path.basename(source))
    if (lstatIfExists(target) || lstatIfExists(targetManifest)) {
      throw new Error(`pin 目标已存在：${target}`)
    }

    let targetPayloadOwned: fs.Stats | null = null
    let targetManifestOwned: fs.Stats | null = null
    let sourcePayloadRemoved = false
    try {
      // A hard link gives pin an atomic no-clobber payload move in this same-directory contract.
      fs.linkSync(source, target)
      targetPayloadOwned = fs.lstatSync(target)
      fs.unlinkSync(source)
      sourcePayloadRemoved = true

      writeControlledBackupManifest(target, targetManifest, path.basename(target))
      targetManifestOwned = fs.lstatSync(targetManifest)
      const targetPair = verifyBackupPair(target, targetManifest, path.basename(target))
      if (targetPair.sha256 !== sourcePair.sha256 || targetPair.size !== sourcePair.size) {
        throw new Error('pin 后 pair digest/size 漂移')
      }
      fs.rmSync(sourceManifest)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (sourcePayloadRemoved && targetPayloadOwned) {
        try {
          const current = fs.lstatSync(target)
          if (current.dev !== targetPayloadOwned.dev || current.ino !== targetPayloadOwned.ino) {
            throw new Error(`pin rollback 无法从所有权已漂移的 target 恢复 source：${target}`)
          }
          fs.linkSync(target, source)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (targetManifestOwned) {
        try {
          removeOwnedFile(targetManifest, targetManifestOwned)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (targetPayloadOwned) {
        try {
          removeOwnedFile(target, targetPayloadOwned)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'pin 失败且未能完整恢复 source pair')
      }
      throw error
    }
  })
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

  // 🔴 进程可见 namespace 的原子发布（P6-R2 复审必修 2）：先写**不匹配 BACKUP_RE 的临时名**，
  //    VACUUM 全程成功后才在同目录 rename 成 backup-*.db。对仍在运行的进程而言，最终名不会以
  //    “改到一半”的状态可见；若直接写最终名，进程被杀会留下有 SQLite 头但内容截断的有效命名，
  //    同时污染 latestBackupDay 与 BACKUP_KEEP 判据。
  //    临时名以 `.tmp-` 打头：既不匹配 BACKUP_RE（不进轮转集），也不匹配 backupLocalDay 的文件名
  //    模式（不被当成「今天备过了」）——残缺产物再也影响不了任何判据。
  //    ⚠️ 遗留清理：tmp 落盘后的**任何**失败路径都由下面那一个 catch 统一删掉（见不变量 B）；
  //    SIGKILL 仍可能留下 `.tmp-backup-*.db`。它可能包含完整敏感数据库，只能保证创建起不宽于
  //    0600、且不会被当成有效备份；必须先核对无活跃写入，再由运维校验/清理。故意不自动清扫同目录
  //    `.tmp-*`：手动 `scripts/backup.ts` 与 worker 每日备份是两个进程，扫一遍会误删对方正在写的文件。
  //    ⚠️ 本实现没有对 tmp、最终文件或目录执行 fsync；不承诺宿主掉电后 tmp/最终名/缺失状态或落盘
  //    顺序。rename 的保证仅限进程可见 namespace，不是断电持久性协议。
  const tmp = path.resolve(backupDir, `.tmp-backup-${ts}-${rand}.db`)
  const manifest = backupManifestPath(target)
  const manifestTmp = path.resolve(backupDir, `.tmp-backup-${ts}-${rand}.db.manifest.json`)

  // 🔴 不变量 B（P6-R2 R7-P2⑤，codex R6 指出）：`tmp` 一旦落盘，**此后任何**失败路径都必须清掉它。
  //
  //    历次复审是一条条堵的：R6-必修2 堵了 VACUUM 抛错，R6-P2④ 堵了发布锁/rename 抛错，而
  //    `fs.chmodSync` 这一行仍在两者**之间**裸奔——备份卷拒绝 chmod（CIFS/FUSE 挂载、属主或 ACL
  //    变了）时它先抛，两个 catch 都接不到，留下一个完整的 .tmp-backup-*.db。它不匹配 BACKUP_RE
  //    也不进 latestBackupDay ⇒ 「今天没备过」恒成立 ⇒ worker 每个 tick 重试、每次再留一个，
  //    直到把磁盘堆满（备份卷满 → 连锁到升级期备份也做不了）。
  //
  //    故不再按「点位」加 catch，改成**一个** try 包住 tmp 之后的全部步骤（VACUUM / chmod /
  //    发布锁 / rename / 轮转），单一清理出口。将来在这中间插新步骤也自动被覆盖，不会再漏。
  //    ⚠️ rename 成功之后才抛错（轮转阶段）时，tmp 已不存在，`force: true` 的 rmSync 是空操作
  //       ——不会误删刚发布的 target。
  //    ⚠️ SIGKILL 仍会留 tmp：它不进轮转/每日判据，但内容仍是敏感全库。因此在 VACUUM 写首字节前
  //       先创建 0600 空文件；后续 chmod 只是发布前纵深防御，不增加宿主掉电持久性保证。
  //       遗留文件由运维手动删；故意不自动清扫同目录 .tmp-*（会误删并发进程正在写的文件）。
  let tmpOwned = false
  let manifestTmpOwned = false
  let pairPublished = false
  try {
    // SQLite 允许 VACUUM INTO 写入“已存在但为空”的文件。先用 wx+0600 创建，既避免进程级 umask
    // 的全局副作用，也保证 SIGKILL 落在任意写入时刻，磁盘上的临时全库从第一字节起就不宽于 0600。
    const tmpFd = fs.openSync(tmp, 'wx', 0o600)
    tmpOwned = true
    fs.closeSync(tmpFd)

    const src = new DatabaseSync(dbPath)
    try {
      src.exec('PRAGMA busy_timeout = 5000')
      src.prepare('VACUUM INTO ?').run(tmp)
    } finally {
      src.close()
    }
    fs.chmodSync(tmp, 0o600) // 先收权限再改名：发布出去的那一刻权限已经是 0600，没有 0644 的窗口
    writeControlledBackupManifest(tmp, manifestTmp, path.basename(target))
    manifestTmpOwned = true

    // 🔴 发布 + 轮转必须在同一把跨进程锁内（见上面 withBackupPublishLock）：rename 与「按 mtime 留 keep-1」
    //    之间若被另一个进程插进来发布，两边的 readdir 都看不到对方那份，就会各自把对方删掉。
    //    锁内先 rename 再 readdir，保证「读到的目录内容」与「自己已发布」是同一个瞬间的视图。
    withBackupPublishLock(backupDir, () => {
      fs.renameSync(tmp, target)
      tmpOwned = false
      // manifest 是 pair 的提交标志：只有快照已完整 rename 到最终名后才发布它。
      fs.renameSync(manifestTmp, manifest)
      manifestTmpOwned = false
      pairPublished = true

      // 保留策略：刚产出的这份必留，其余按 mtime 新→旧排序再留 keep-1 份，更旧的删掉
      const others = fs
        .readdirSync(backupDir)
        .filter((f) => BACKUP_RE.test(f))
        .map((f) => path.resolve(backupDir, f))
        .filter((p) => p !== target)
        .filter((p) => isCompleteBackupPair(p))
        .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const old of others.slice(keep - 1)) {
        // 删除顺序与发布相反：先移除 manifest 提交标志，再删数据库 payload。
        fs.rmSync(backupManifestPath(old.p), { force: true })
        fs.rmSync(old.p, { force: true })
      }
    })
  } catch (err) {
    if (!pairPublished) {
      if (manifestTmpOwned) fs.rmSync(manifestTmp, { force: true })
      if (tmpOwned) fs.rmSync(tmp, { force: true }) // 只清本进程创建的 tmp；随机名碰撞时不能删别人的文件
      // 数据库 rename 成功但 manifest 尚未提交时，最终名不是可恢复 pair，正常失败路径把它收回。
      fs.rmSync(manifest, { force: true })
      fs.rmSync(target, { force: true })
    }
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
    if (day === null) continue
    const snapshot = path.resolve(dir, f)
    if (!isCompleteBackupPair(snapshot)) continue
    if (latest === null || day > latest) latest = day // 'YYYY-MM-DD' 定长，字典序即日序
  }
  return latest
}

function hasBackupOnLocalDay(dir: string, day: string): boolean {
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return false
  }
  return files.some((f) => backupLocalDay(f) === day && isCompleteBackupPair(path.resolve(dir, f)))
}

// 当天（now 所在的服务器本地自然日）若尚无备份 → 备一份并返回 true；已有则跳过返回 false。
// now 注入以可测（跨日判定确定性）；调用方传真实时钟。
// 备份本身失败会照常抛出，由调用方（worker 第四段）捕获记日志——绝不静默吞掉备份失败。
export function dailyBackupIfDue(now: Date, dbPath: string, dir: string, keep: number): boolean {
  const today = localDayStr(now)
  // 只有“今天本地日”的有效 backup-*.db 才能满足今日门禁。宿主时钟曾跳快留下的未来文件仍可
  // 安全保留并参与正常轮转，但不能替代今天的恢复点。
  if (hasBackupOnLocalDay(dir, today)) return false
  backupDb(dbPath, dir, keep, now) // 传同一个 now：命名与判定同源，日界前后不会互相错位
  return true
}
