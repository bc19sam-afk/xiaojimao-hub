import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupDb, dailyBackupIfDue, latestBackupDay } from '../lib/backup.ts'

// ============================================================================
// P6-R2 ②：每日自动备份（lib/backup.ts）
//
// 核心纪律：「今天是否已备份」的判据在**磁盘文件名**上，不靠进程内存——
// restart:unless-stopped 崩溃循环下绝不产生备份 churn（P6-R1 三轮修复换来的）。
//
// ⚠️ 隔离红线：全程临时目录，收显式路径参数，不 import lib/db.ts、不碰 DB_PATH。
// ⚠️ 时间：全部注入 now，不卡真实时钟（CI 负载下会 flaky）。
// ============================================================================

let tmpDir: string

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-daily-bak-'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// 建一个最小可备份的源库
function makeDb(dir: string): string {
  const dbPath = path.join(dir, 'app.db')
  const d = new DatabaseSync(dbPath)
  d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  d.prepare('INSERT INTO t (id) VALUES (1)').run()
  d.close()
  return dbPath
}

function backupsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => /^backup-.*\.db$/.test(f))
}

// 造一个「文件名声称落在某个本地日某时刻」的假备份文件。
// 文件名时间戳是 UTC（与 backupDb 的 toISOString 同源），故按本地时刻反推 UTC 再格式化——
// 这样测试里说的「本地 7 月 26 日 09:00」在任何 TZ 下都成立。
function fakeBackupAtLocal(dir: string, localIso: string, tag: string): string {
  const at = new Date(localIso) // 无 Z 后缀 = 按本地时区解析
  const u = at.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const name = `backup-${u}-${tag}.db`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), 'stub')
  return name
}

// ===== latestBackupDay =====

test('latestBackupDay：目录不存在 / 空目录 → null', () => {
  assert.equal(latestBackupDay(path.join(tmpDir, 'nope')), null)
  const empty = fs.mkdtempSync(path.join(tmpDir, 'empty-'))
  assert.equal(latestBackupDay(empty), null)
})

test('latestBackupDay：多份取最大日（按本地日，不是字符串排序碰巧）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'multi-'))
  fakeBackupAtLocal(dir, '2026-07-24T09:00:00', 'aaaaaa')
  fakeBackupAtLocal(dir, '2026-07-26T09:00:00', 'bbbbbb')
  fakeBackupAtLocal(dir, '2026-07-25T09:00:00', 'cccccc')
  assert.equal(latestBackupDay(dir), '2026-07-26')
})

test('latestBackupDay：preupgrade.db / pre-restore.db / 垃圾名一律忽略', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'ignore-'))
  fs.writeFileSync(path.join(dir, 'preupgrade.db'), 'x') // 钉住的升级前快照，不进轮转集
  fs.writeFileSync(path.join(dir, 'pre-restore.db'), 'x') // 恢复前现场，同样不算日常备份
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'x')
  fs.writeFileSync(path.join(dir, 'backup-not-a-date.db'), 'x')
  fs.writeFileSync(path.join(dir, 'app.db'), 'x')
  assert.equal(latestBackupDay(dir), null)
  // 混入一份真正的备份后，只认它
  fakeBackupAtLocal(dir, '2026-07-26T09:00:00', 'dddddd')
  assert.equal(latestBackupDay(dir), '2026-07-26')
})

// 🔴 时区回归：backupDb 文件名是 UTC 时间戳，日切判定用本地日。东八区 00:00–08:00 产出的备份，
// 文件名里写着**昨天**的 UTC 日期——若实现直接截文件名前 10 字符当本地日，这里就会判错。
test('latestBackupDay：UTC 文件名 → 本地日换算（东八区凌晨那 8 小时不误判）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'tz-'))
  // 本地 07-26 00:30 —— TZ=Asia/Shanghai 时其 UTC 名字是 2026-07-25T16-30-00
  const name = fakeBackupAtLocal(dir, '2026-07-26T00:30:00', 'eeeeee')
  assert.equal(latestBackupDay(dir), '2026-07-26', `文件名=${name} 应折算为本地日 2026-07-26`)
})

// ===== dailyBackupIfDue =====

test('dailyBackupIfDue：当日无备份 → 产一份返 true', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'due-'))
  const dbPath = makeDb(dir)
  const backups = path.join(dir, 'backups')
  assert.equal(dailyBackupIfDue(new Date('2026-07-26T09:00:00'), dbPath, backups, 7), true)
  assert.equal(backupsIn(backups).length, 1)
})

// 🔴 防 churn 核心断言：同一本地日内反复调用（模拟 8s 一 tick、以及崩溃重启后重新调用）
// 绝不能再产备份。判据在磁盘文件名上，故「新进程」也不会重备。
test('dailyBackupIfDue：同日重复调用 → false 且不再产备份（防 churn）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'churn-'))
  const dbPath = makeDb(dir)
  const backups = path.join(dir, 'backups')
  const now = new Date('2026-07-26T09:00:00')
  assert.equal(dailyBackupIfDue(now, dbPath, backups, 7), true)
  const after1 = backupsIn(backups)
  assert.equal(after1.length, 1)

  // 同日再调 20 次（含跨小时、含日内更晚时刻）——一份都不许多
  for (let i = 0; i < 20; i++) {
    assert.equal(dailyBackupIfDue(new Date('2026-07-26T09:00:05'), dbPath, backups, 7), false)
  }
  assert.equal(dailyBackupIfDue(new Date('2026-07-26T23:59:59'), dbPath, backups, 7), false)
  assert.deepEqual(backupsIn(backups), after1, '同一本地日内不得产生第二份备份')
})

test('dailyBackupIfDue：跨到次日 → 再产一份', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'nextday-'))
  const dbPath = makeDb(dir)
  const backups = path.join(dir, 'backups')
  assert.equal(dailyBackupIfDue(new Date('2026-07-26T09:00:00'), dbPath, backups, 7), true)
  assert.equal(dailyBackupIfDue(new Date('2026-07-27T00:05:00'), dbPath, backups, 7), true)
  assert.equal(backupsIn(backups).length, 2)
  // 次日再调仍然只有两份
  assert.equal(dailyBackupIfDue(new Date('2026-07-27T18:00:00'), dbPath, backups, 7), false)
  assert.equal(backupsIn(backups).length, 2)
})

// 时钟回拨（NTP 校正 / 宿主时间被改）：不该因为「今天 < 最近备份日」就再备一份。
test('dailyBackupIfDue：时钟回拨到更早的日子 → 不重复备份', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'rollback-'))
  const dbPath = makeDb(dir)
  const backups = path.join(dir, 'backups')
  assert.equal(dailyBackupIfDue(new Date('2026-07-26T09:00:00'), dbPath, backups, 7), true)
  assert.equal(dailyBackupIfDue(new Date('2026-07-25T09:00:00'), dbPath, backups, 7), false)
  assert.equal(backupsIn(backups).length, 1)
})

// preupgrade.db 是升级前钉住的回滚点、不算「今天的日常备份」：它在目录里也不该抑制当日备份。
test('dailyBackupIfDue：目录里只有 preupgrade.db → 仍会产当日备份', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'preup-'))
  const dbPath = makeDb(dir)
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(backups, { recursive: true })
  fs.writeFileSync(path.join(backups, 'preupgrade.db'), 'x')
  assert.equal(dailyBackupIfDue(new Date('2026-07-26T09:00:00'), dbPath, backups, 7), true)
  assert.equal(backupsIn(backups).length, 1)
  assert.ok(fs.existsSync(path.join(backups, 'preupgrade.db')), 'preupgrade.db 不得被轮转掉')
})

// 与 BACKUP_KEEP 轮转的衔接：keep=7 ⇒ 日备份自然保 7 天（不加新开关的前提）。
// 这里用 keep=3 快速验证：连备 5 天后只剩最近 3 天。
test('dailyBackupIfDue：连续多日备份受 BACKUP_KEEP 轮转（keep 天数即保留天数）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'rotate-'))
  const dbPath = makeDb(dir)
  const backups = path.join(dir, 'backups')
  for (const d of ['22', '23', '24', '25', '26']) {
    assert.equal(dailyBackupIfDue(new Date(`2026-07-${d}T09:00:00`), dbPath, backups, 3), true)
  }
  assert.equal(backupsIn(backups).length, 3)
  assert.equal(latestBackupDay(backups), '2026-07-26')
})

// 备份失败照常抛出（磁盘满/源库缺失），由调用方 worker 捕获记日志——绝不静默吞掉。
test('dailyBackupIfDue：源库不存在 → 抛错（不静默吞）', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'missing-'))
  assert.throws(
    () => dailyBackupIfDue(new Date('2026-07-26T09:00:00'), path.join(dir, 'nope.db'), path.join(dir, 'backups'), 7),
    /源库不存在/,
  )
})

// backupDb 现有命名格式与 latestBackupDay 的解析必须始终对得上（防将来改命名把日备份闸悄悄弄瞎）
test('命名契约：backupDb 真实产出的文件名能被 latestBackupDay 解析', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'contract-'))
  const dbPath = makeDb(dir)
  const backups = path.join(dir, 'backups')
  backupDb(dbPath, backups, 7)
  const today = new Date()
  const expect = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`
  assert.equal(latestBackupDay(backups), expect)
})
