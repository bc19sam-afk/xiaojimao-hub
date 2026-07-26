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

// ============================================================================
// 跨进程发布锁（P6-R2 复审三轮第 5 条）
//
// 手动 `npm run backup` 与 worker 每日备份是两个进程。发布(rename)与轮转(按 mtime 留 keep-1)
// 之间若被对方插进来，两边的 readdir 都看不到对方那份 → 各自把对方刚发布的删掉。
// `BACKUP_KEEP=1` 时 slice(0)＝删掉除自己以外全部，最坏结果是**目录里一份不剩**，而两次调用
// 都返回成功路径——静默的备份全丢。
//
// 紧对齐测法（同 seed-concurrency.test.ts）：N 个子进程各自 import 真实 backupDb、写 ready 文件、
// 忙旋等 GO；父进程见 N 个 ready 齐了才落 GO，把它们同刻放行。破损版实测 15/20 轮出错
// （13 轮剩 0 份、2 轮剩 2 份）且 10 轮因 readdir 与 statSync 之间文件被对方删掉而 ENOENT 崩溃；
// 修复版 20/20 轮精确剩 1 份、零崩溃。取 5 轮＝破损版漏检概率 0.25^5≈0.1%。
// ⚠️ 隔离红线：全程临时目录，子进程只收显式路径参数，不碰 DB_PATH / 真实 data。
// ============================================================================

// 子进程：import 真实 backupDb → 写 ready → 忙旋等 GO → 备份。忙旋（非 sleep 轮询）是为了
// 把「放行 → 进临界区」的抖动压到微秒级，否则毫秒级抖动远大于临界区宽度、根本撞不上。
const RACE_CHILD_SRC = [
  "import fs from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  'const { MOD, DB, DIR, BARRIER, READY, KEEP } = process.env',
  'const { backupDb } = await import(pathToFileURL(MOD).href)',
  "fs.writeFileSync(READY, '')",
  'while (!fs.existsSync(BARRIER)) {}',
  'backupDb(DB, DIR, Number(KEEP))',
  '',
].join('\n')

test('跨进程锁：N 进程紧对齐同刻备份 → 精确剩 keep 份、零崩溃（不互删）', async () => {
  const N = 4
  const ROUNDS = 5
  const KEEP = 1 // keep=1 是最坏情形：slice(0) 删掉除自己以外全部
  const raceDir = fs.mkdtempSync(path.join(tmpDir, 'xproc-lock-'))
  const childPath = path.join(raceDir, 'race-child.mjs')
  fs.writeFileSync(childPath, RACE_CHILD_SRC)
  const setupPath = path.resolve(import.meta.dirname, 'setup.mjs')
  const modPath = path.resolve(import.meta.dirname, '../lib/backup.ts')

  for (let r = 0; r < ROUNDS; r++) {
    const roundDir = path.join(raceDir, `r${r}`)
    fs.mkdirSync(roundDir, { recursive: true })
    const dbPath = path.join(roundDir, 'app.db')
    const d = new DatabaseSync(dbPath)
    d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    d.prepare('INSERT INTO t (id) VALUES (1)').run()
    d.close()
    const backupsDir = path.join(roundDir, 'backups')
    fs.mkdirSync(backupsDir)
    const readyDir = path.join(roundDir, 'ready')
    fs.mkdirSync(readyDir)
    const barrier = path.join(roundDir, 'GO')

    const procs = Array.from({ length: N }, (_v, i) => {
      const c = spawn(process.execPath, ['--import', setupPath, childPath], {
        env: {
          ...process.env,
          MOD: modPath,
          DB: dbPath,
          DIR: backupsDir,
          BARRIER: barrier,
          READY: path.join(readyDir, String(i)),
          KEEP: String(KEEP),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      c.stderr.on('data', (b) => (stderr += b))
      return new Promise<{ code: number | null; stderr: string }>((res) =>
        c.on('exit', (code) => res({ code, stderr })),
      )
    })

    // 等所有子进程都到 backupDb 门口再统一放行
    const deadline = Date.now() + 20_000
    while (fs.readdirSync(readyDir).length < N) {
      if (Date.now() > deadline) throw new Error(`第 ${r} 轮：子进程未在 20s 内就绪`)
      await sleep(5)
    }
    fs.writeFileSync(barrier, '1')
    const results = await Promise.all(procs)

    // 崩溃也是本条的真实症状：破损版会在 readdir 与 statSync 之间被对方删掉文件而 ENOENT
    const crashed = results.filter((x) => x.code !== 0)
    assert.equal(
      crashed.length,
      0,
      `第 ${r} 轮：并发备份不应崩溃；失败 ${crashed.length}/${N}，样例 stderr：\n${crashed[0]?.stderr ?? ''}`,
    )
    const left = fs.readdirSync(backupsDir).filter((f) => /^backup-.*\.db$/.test(f))
    assert.equal(
      left.length,
      KEEP,
      `🔴 第 ${r} 轮：${N} 进程并发备份后应精确剩 ${KEEP} 份，实际 ${left.length} 份` +
        `（0 份＝互删光了，每个进程却都返回了成功路径）。目录：${JSON.stringify(fs.readdirSync(backupsDir))}`,
    )
  }
})

// 锁文件本身不得污染任何判据：不进轮转集、不被 latestBackupDay 当成「今天备过了」
test('跨进程锁：.backup.lock 不进轮转集、不影响 latestBackupDay', async () => {
  const { latestBackupDay } = await import('../lib/backup.ts')
  const dir = fs.mkdtempSync(path.join(tmpDir, 'lockfile-'))
  const { src, dbPath } = makeWalDb(dir, 1)
  src.close()
  const backupsDir = path.join(dir, 'backups')

  backupDb(dbPath, backupsDir, 1, new Date('2026-07-24T09:00:00'))
  assert.ok(fs.existsSync(path.join(backupsDir, '.backup.lock')), '锁文件应已建在备份目录里')
  assert.equal(latestBackupDay(backupsDir), '2026-07-24', '锁文件不得被当成备份参与日判定')

  // keep=1 再备一次：锁文件不占名额（占了的话真备份会被挤掉），且自己不被轮转删
  const second = backupDb(dbPath, backupsDir, 1, new Date('2026-07-25T09:00:00'))
  assert.ok(fs.existsSync(second), '轮转后本次备份应仍在')
  assert.ok(fs.existsSync(path.join(backupsDir, '.backup.lock')), '锁文件不该被轮转删掉')
  assert.deepEqual(
    fs.readdirSync(backupsDir).filter((f) => /^backup-.*\.db$/.test(f)),
    [path.basename(second)],
    'keep=1 时应恰好剩最新那一份',
  )
})
