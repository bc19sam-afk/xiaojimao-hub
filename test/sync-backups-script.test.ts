import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// ============================================================================
// scripts/sync-backups.sh 回归（P6-R2 R4③）
//
// 用桩 rsync 捕获参数，验证 --partial-dir 在位、不用裸 --partial。
// ============================================================================

const REPO = path.resolve(import.meta.dirname, '..')
const SYNC_SH = path.join(REPO, 'scripts', 'sync-backups.sh')

test('R4③：rsync 用 --partial-dir 而非裸 --partial（防半截文件污染异机候选集）', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-sync-'))
  try {
    const backupsDir = path.join(tmpRoot, 'backups')
    fs.mkdirSync(backupsDir, { recursive: true })
    fs.writeFileSync(path.join(backupsDir, 'backup-test.db'), 'dummy')

    const binDir = path.join(tmpRoot, 'bin')
    fs.mkdirSync(binDir)
    const logFile = path.join(tmpRoot, 'rsync.log')

    // 桩 rsync：记录所有参数到日志
    const rsyncStub = path.join(binDir, 'rsync')
    fs.writeFileSync(
      rsyncStub,
      `#!/bin/sh
echo "$@" > "${logFile}"
exit 0
`,
      { mode: 0o755 },
    )

    const r = spawnSync(SYNC_SH, ['user@host:/remote'], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        BACKUP_DIR: backupsDir,
      },
      encoding: 'utf8',
    })

    assert.equal(r.status, 0, `脚本应成功退出（stderr: ${r.stderr})`)
    const args = fs.readFileSync(logFile, 'utf8').trim()
    assert.ok(
      args.includes('--partial-dir=.rsync-partial'),
      `应使用 --partial-dir（实际参数: ${args}）`,
    )
    assert.ok(!args.match(/\s--partial\s/), `不应有裸 --partial（实际参数: ${args}）`)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})
