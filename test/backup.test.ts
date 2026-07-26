import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { backupDb } from '../lib/backup.ts'

// ⚠️ 测试库隔离（红线）：全程临时目录。backupDb 收显式路径，
// 不 import lib/db.ts、不碰 DB_PATH，绝不读写真实 data/app.db。

let tmpDir: string

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-bak-'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// 建一个 WAL 模式源库并写入 rows 行；连接保持打开由调用方处置
function makeWalDb(dir: string, rows: number): { src: DatabaseSync; dbPath: string } {
  const dbPath = path.join(dir, 'src.db')
  const src = new DatabaseSync(dbPath)
  src.exec('PRAGMA journal_mode = WAL')
  src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  const ins = src.prepare('INSERT INTO t (id, name) VALUES (?, ?)')
  for (let i = 1; i <= rows; i++) ins.run(i, 'row-' + i)
  return { src, dbPath }
}

// ① 一致性：源连接不 close、不 checkpoint，数据还躺在 -wal 里（裸 cp 会丢的部分），
//    此时做备份，备份文件仍含全部数据
test('一致性：WAL 未 checkpoint、源连接保持打开，备份仍含全部数据', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'consistency-'))
  const { src, dbPath } = makeWalDb(dir, 50)
  // 前置断言：数据确实尚未 checkpoint 到主文件
  const wal = dbPath + '-wal'
  assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, '预期 -wal 存在且非空')

  const backupPath = backupDb(dbPath, path.join(dir, 'backups'), 3) // src 仍打开

  const restored = new DatabaseSync(backupPath)
  const n = restored.prepare('SELECT COUNT(*) AS n FROM t').get() as unknown as { n: number }
  assert.equal(n.n, 50)
  restored.close()
  // 权限收紧 0600
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600)
  src.close()
})

// ② 恢复验证：把备份文件当新库打开，跑真实查询拿回写入的数据，完整性检查通过
test('恢复验证：备份文件可作为新库打开并查回写入的数据', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'restore-'))
  const { src, dbPath } = makeWalDb(dir, 3)
  const backupPath = backupDb(dbPath, path.join(dir, 'backups'), 3)
  src.close()

  const restored = new DatabaseSync(backupPath)
  const row = restored.prepare('SELECT name FROM t WHERE id = ?').get(2) as unknown as {
    name: string
  }
  assert.equal(row.name, 'row-2')
  const ic = restored.prepare('PRAGMA integrity_check').get() as unknown as {
    integrity_check: string
  }
  assert.equal(ic.integrity_check, 'ok')
  restored.close()
})

// ③ 保留策略：连做 keep+2 次备份，目录里只剩最新的 keep 份；不相干文件不受清理波及
test('保留策略：keep+2 次备份后只剩最新 keep 份', async () => {
  const keep = 3
  const dir = fs.mkdtempSync(path.join(tmpDir, 'retention-'))
  const { src, dbPath } = makeWalDb(dir, 1)
  src.close()
  const backupsDir = path.join(dir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  fs.writeFileSync(path.join(backupsDir, 'keep-me.txt'), 'x') // 非备份文件，不许被删

  const made: string[] = []
  for (let i = 0; i < keep + 2; i++) {
    made.push(backupDb(dbPath, backupsDir, keep))
    await sleep(10) // 拉开 mtime，让「最新的那批」判定无歧义
  }

  const left = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => path.resolve(backupsDir, f))
    .sort()
  assert.deepEqual(left, [...made.slice(-keep)].sort()) // 恰好是最新那 keep 份
  assert.ok(fs.existsSync(path.join(backupsDir, 'keep-me.txt')))
})

// ============================================================================
// 原子发布（P6-R2 复审必修 2）
//
// VACUUM 中途被杀会留下「有 SQLite 头但内容截断」的文件。若它叫 backup-*.db，就同时污染两条
// 判据：latestBackupDay 判「今天备过了」→ 整天不备；BACKUP_KEEP 轮转集也认它 → 挤掉真好备份。
// 故必须先写不匹配 ^backup-.*\.db$ 的临时名，VACUUM 全程成功后才 rename 就位。
// ============================================================================

// ④ 🔴 直接观测「VACUUM 正在写的那个中间文件名」：必须不是 backup-*.db。
//    做法：子进程跑真实 backupDb，父进程**同步忙轮询 readdir** 采样目录内容，直到最终产物出现。
//    ⚠️ 不能用 fs.watch：macOS 下它走 FSEvents，实测投递延迟约 50ms，而本例这种小库的 VACUUM
//       只要 2ms（实测 0.9MB→2ms / 17MB→28ms）——回调根本来不及触发，`seen` 为空、测试假红
//       （本地实测 8 次跑挂 4 次）。忙轮询没有这个问题：readdir 约几十微秒一次，对 28ms 的 VACUUM
//       能采上千次，且父子两进程在负载下同比例变慢、比值不变（同 ⑤ 的取窗方式）。
test('原子发布：中间文件名不匹配 backup-*.db（忙轮询捕获真实写入序列）', async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'atomic-name-'))
  const dbPath = path.join(dir, 'big.db')
  const backupsDir = path.join(dir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  // 源库要够大，VACUUM 才有可观测的时长窗口（40000 行≈17MB，实测 VACUUM 约 28ms）
  const d = new DatabaseSync(dbPath)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, blob TEXT)')
  const ins = d.prepare('INSERT INTO big (blob) VALUES (?)')
  d.exec('BEGIN')
  for (let i = 0; i < 40000; i++) ins.run('x'.repeat(400))
  d.exec('COMMIT')
  d.close()

  const child = spawn(
    process.execPath,
    [
      '--import',
      path.resolve(import.meta.dirname, 'setup.mjs'),
      '-e',
      `import('${path.resolve(import.meta.dirname, '../lib/backup.ts')}').then(m => {
         process.send?.('start')
         m.backupDb(${JSON.stringify(dbPath)}, ${JSON.stringify(backupsDir)}, 3)
       })`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  )
  const exited = new Promise<void>((res) => child.once('exit', () => res()))
  await new Promise<void>((res) => child.once('message', () => res())) // 忙轮询前先等 IPC（忙轮询会堵住事件循环）

  // 采样：收集本次备份过程中目录里出现过的所有文件名，直到最终产物就位
  const seen = new Set<string>()
  const deadline = Date.now() + 10000
  let published = false
  while (Date.now() < deadline && !published) {
    for (const n of fs.readdirSync(backupsDir)) {
      seen.add(n)
      if (/^backup-.*\.db$/.test(n)) published = true
    }
  }
  await exited

  assert.ok(published, `10s 内未观测到最终产物，本例失效：${JSON.stringify([...seen])}`)
  const finalName = fs.readdirSync(backupsDir).find((n) => /^backup-.*\.db$/.test(n))
  // 采样期间叫 backup-*.db 的只能是最终那一个名字；不能出现第二个
  assert.deepEqual(
    [...seen].filter((n) => /^backup-.*\.db$/.test(n)),
    [finalName],
    `🔴 写入过程中出现了额外的 backup-*.db 名字：${JSON.stringify([...seen])}`,
  )
  // 且确实经过了 .tmp- 中间名（证明走的是「先临时名后 rename」，不是碰巧只写一次）
  assert.ok(
    [...seen].some((n) => n.startsWith('.tmp-backup-')),
    `🔴 未观测到 .tmp- 中间文件＝VACUUM 直接写的最终名，实际采到：${JSON.stringify([...seen])}`,
  )
})

// ④b 硬杀留下的 .tmp- 遗留文件，对两条判据都无害
test('原子发布：遗留的 .tmp-backup-*.db 不影响 latestBackupDay 与轮转集', async () => {
  const { latestBackupDay } = await import('../lib/backup.ts')
  const dir = fs.mkdtempSync(path.join(tmpDir, 'atomic-orphan-'))
  const { src, dbPath } = makeWalDb(dir, 1)
  src.close()
  const backupsDir = path.join(dir, 'backups')
  // 先备一份「7 月 24 日」的，再放一个「7 月 26 日」的残缺临时遗留
  backupDb(dbPath, backupsDir, 3, new Date('2026-07-24T09:00:00'))
  const before = latestBackupDay(backupsDir)

  const orphan = path.join(backupsDir, '.tmp-backup-2026-07-26T09-00-00-abcdef.db')
  fs.writeFileSync(orphan, 'SQLite format 3 truncated-garbage')
  assert.equal(
    latestBackupDay(backupsDir),
    before,
    '🔴 遗留的 .tmp- 文件不得被当成「更晚的备份」——否则当天不再备份',
  )

  // 也不该占轮转名额：keep=1 时轮转后真备份仍在
  backupDb(dbPath, backupsDir, 1, new Date('2026-07-27T09:00:00'))
  assert.ok(fs.existsSync(orphan), '轮转只认 backup-*.db，不该去删 .tmp-（可能是别的进程在写）')
})

// ⑤ 🔴🔴 核心回归：**真的 SIGKILL 掉正在 VACUUM 的进程**，断言目录里零个 backup-*.db。
//    这是本条修复要防的那个确切场景（断电/OOM kill），也是唯一能钉住「先临时名后 rename」的测法——
//    抛错路径早就被 catch 兜住了（修复前也过），只有硬杀会暴露「直接写最终名」的问题。
test('原子发布：VACUUM 中途进程被 SIGKILL → 不留下任何 backup-*.db', async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'atomic-kill-'))
  const dbPath = path.join(dir, 'big.db')
  const backupsDir = path.join(dir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  // 建一个「大到 VACUUM 需要可观测时间」的源库：VACUUM 期间才有窗口去杀
  const d = new DatabaseSync(dbPath)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, blob TEXT)')
  const ins = d.prepare('INSERT INTO big (blob) VALUES (?)')
  d.exec('BEGIN')
  for (let i = 0; i < 40000; i++) ins.run('x'.repeat(400))
  d.exec('COMMIT')
  d.close()

  // 子进程跑真实的 backupDb，父进程**忙轮询**到目标文件刚出现就 SIGKILL。
  // 不用固定 sleep：VACUUM 只要几十毫秒，睡过头子进程就正常跑完了（那样杀的是个已退出的进程、
  // once('exit') 永不触发 → 测试挂死）。轮询在文件出现后 ~1ms 内下手，窗口利用率最高。
  const child = spawn(
    process.execPath,
    [
      '--import',
      path.resolve(import.meta.dirname, 'setup.mjs'),
      '-e',
      `import('${path.resolve(import.meta.dirname, '../lib/backup.ts')}').then(m => {
         process.send?.('start')
         m.backupDb(${JSON.stringify(dbPath)}, ${JSON.stringify(backupsDir)}, 7)
       })`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  // exit 监听必须在杀之前挂好，否则「已退出才注册」会永远等不到事件
  const exited = new Promise<void>((res) => child.once('exit', () => res()))
  await new Promise<void>((res) => child.once('message', () => res()))

  const deadline = Date.now() + 5000
  let caught = false
  while (Date.now() < deadline) {
    if (fs.readdirSync(backupsDir).length > 0) {
      caught = true
      break
    }
  }
  child.kill('SIGKILL')
  await exited

  const leftovers = fs.readdirSync(backupsDir)
  assert.ok(caught, `5s 内没观测到 VACUUM 写出任何文件，本例失效：${JSON.stringify(leftovers)}`)
  assert.deepEqual(
    leftovers.filter((f) => /^backup-.*\.db$/.test(f)),
    [],
    `🔴 被硬杀后留下了 backup-*.db，它会被 latestBackupDay 当成「今天备过了」并占轮转名额：${JSON.stringify(leftovers)}`,
  )
})

// ⑤b VACUUM 抛错（可捕获的失败路径）也不留残骸
test('原子发布：VACUUM 抛错 → 目录里不留任何 backup-*.db（不发布残缺文件）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'atomic-fail-'))
  // 造一个「有 SQLite 头但内容损坏」的源库：VACUUM 读它会抛 malformed
  const { src, dbPath } = makeWalDb(dir, 3)
  src.close()
  const brokenPath = path.join(dir, 'broken.db')
  const good = fs.readFileSync(dbPath)
  const corrupt = Buffer.from(good)
  corrupt.fill(0xff, 100, Math.min(corrupt.length, 3000)) // 打烂页内容，保留文件头
  fs.writeFileSync(brokenPath, corrupt)

  const backupsDir = path.join(dir, 'backups')
  assert.throws(() => backupDb(brokenPath, backupsDir, 3), /malformed|corrupt|disk image/i)

  const leftovers = fs.readdirSync(backupsDir)
  assert.deepEqual(
    leftovers.filter((f) => /^backup-.*\.db$/.test(f)),
    [],
    '🔴 VACUUM 失败后绝不能留下 backup-*.db —— 它会被当成有效备份',
  )
  assert.deepEqual(leftovers, [], '临时文件也应被清掉')
})

// ⑥ 发布出去的那一刻权限就是 0600（先 chmod 再 rename，不留 0644 窗口）
test('原子发布：产物权限 0600（chmod 在 rename 之前）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'atomic-mode-'))
  const { src, dbPath } = makeWalDb(dir, 1)
  src.close()
  const p = backupDb(dbPath, path.join(dir, 'backups'), 3)
  assert.equal(fs.statSync(p).mode & 0o777, 0o600)
})
