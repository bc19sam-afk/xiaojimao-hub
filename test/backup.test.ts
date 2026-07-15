import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
