import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(import.meta.dirname, '..')
const restoreScript = path.join(REPO, 'scripts', 'restore.sh')
const watchdogScript = path.join(REPO, 'scripts', 'restore-watchdog.mjs')

test('P6-R2 restore policy lint：不得引入 Docker socket 或独立 watchdog', () => {
  assert.equal(fs.existsSync(watchdogScript), false, 'restore watchdog helper 必须从最终方案删除')

  const source = fs.readFileSync(restoreScript, 'utf8')
  assert.doesNotMatch(source, /DOCKER_SOCKET_PATH|docker\.sock|Engine API|engine-api|restore-watchdog/)
  assert.doesNotMatch(source, /start_restore_watchdog|renew_watchdog_lease|wait_watchdog|watchdog-disarmed/)
})

for (const shell of ['sh', 'bash', 'dash']) {
  test(`P6-R2 restore executable syntax：${shell} -n`, () => {
    const result = spawnSync(shell, ['-n', restoreScript], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${shell} -n failed:\n${result.stdout}\n${result.stderr}`)
  })
}
