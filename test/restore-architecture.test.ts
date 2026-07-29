import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const restoreScript = path.join(REPO, 'scripts', 'restore.sh')
const watchdogScript = path.join(REPO, 'scripts', 'restore-watchdog.mjs')

test('P6-R2 restore 隔离边界：最终方案不得引入 Docker socket 或独立 watchdog', () => {
  assert.equal(fs.existsSync(watchdogScript), false, 'restore watchdog helper 必须从最终方案删除')

  const source = fs.readFileSync(restoreScript, 'utf8')
  assert.doesNotMatch(source, /DOCKER_SOCKET_PATH|docker\.sock|Engine API|engine-api|restore-watchdog/)
  assert.doesNotMatch(source, /start_restore_watchdog|renew_watchdog_lease|wait_watchdog|watchdog-disarmed/)
})

test('P6-R2 restore 提交顺序：隔离与 accepted 必须先于网络发布，network-published 必须最后提交', () => {
  const source = fs.readFileSync(restoreScript, 'utf8')
  const disconnectAt = source.indexOf('disconnect_container_networks 0')
  const startAt = source.lastIndexOf('docker start "$RESTORE_CONTAINER_ID"')
  const isolatedBeforeAcceptedAt = source.indexOf('verify_captured_container_isolated "接受 readiness 前"')
  const acceptedAt = source.indexOf('write_restore_state "$RESTORE_CONTROL_READY_ACCEPTED"')
  const reconnectAt = source.indexOf('if ! reconnect_container_networks; then')
  const publishedAt = source.indexOf('write_restore_state "$RESTORE_CONTROL_NETWORK_PUBLISHED"')

  for (const [label, position] of Object.entries({
    disconnectAt,
    startAt,
    isolatedBeforeAcceptedAt,
    acceptedAt,
    reconnectAt,
    publishedAt,
  })) {
    assert.ok(position >= 0, `缺少方案 A 顺序节点：${label}`)
  }
  assert.ok(disconnectAt < startAt, 'exact 容器必须在 start 前完成停止态断网')
  assert.ok(isolatedBeforeAcceptedAt < acceptedAt, '写 accepted 前必须再次确认网络集合为空')
  assert.ok(acceptedAt < reconnectAt, '任何 network connect 前必须先持久化 ready-accepted')
  assert.ok(reconnectAt < publishedAt, '全部 reconnect 与复核完成后才允许写 network-published')
})

test('P6-R2 restore 权限与网络契约：readiness 经 0600 临时文件提权发布，动态 MAC 不参与重放', () => {
  const source = fs.readFileSync(restoreScript, 'utf8')
  assert.doesNotMatch(source, />\s*"\$RESTORE_CONTROL_READY_BODY"/)
  assert.match(source, /install -m 600 "\$READY_BODY_TMP" "\$RESTORE_CONTROL_READY_BODY"/)
  assert.match(source, /docker network connect/)
  assert.doesNotMatch(source, /docker network connect[^\n]*--mac-address/)
})
