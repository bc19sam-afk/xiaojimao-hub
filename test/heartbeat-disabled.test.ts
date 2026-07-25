import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================================
// P6-R2 ④：dead-man 心跳 —— HEARTBEAT_URL 非法（非 http/https 开头）视为关闭
//
// env 是模块级单例、每进程固定 ⇒ 「合法 URL」与「非法 URL」两种配置必须分文件
// （同项目既有的「MOCK 按文件分」纪律，见 test/normFile 与 collect 的拆分）。
//
// 设计取舍：配错告警通道不该拒绝启动（不同于 SESSION_SECRET/CPA 的 fail-fast）——
// 心跳是可选增强项，拖垮收号主链路得不偿失。故：警告一次 + 按未配置处理。
// ============================================================================

let pingHeartbeat: typeof import('../lib/worker.ts').pingHeartbeat
let env: typeof import('../lib/env.ts').env
let tmpDir: string
const warns: string[] = []

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-hb-off-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  process.env.HEARTBEAT_URL = 'hc-ping.example/uuid-placeholder' // 缺 scheme = 非法
  // 捕获 env 模块首次求值时的告警（import 期间发生，故先接管 console.warn）
  const origWarn = console.warn
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
  try {
    ;({ env } = await import('../lib/env.ts'))
    ;({ pingHeartbeat } = await import('../lib/worker.ts'))
  } finally {
    console.warn = origWarn
  }
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('心跳：非 http(s) 的 HEARTBEAT_URL → 解析为空（视为关闭）', () => {
  assert.equal(env.worker.heartbeatUrl, '')
})

test('心跳：URL 非法时启动期告警一次，且不回显配错的值（§8 脱敏）', () => {
  const hits = warns.filter((w) => w.includes('HEARTBEAT_URL'))
  assert.equal(hits.length, 1, '应有且仅有一条 HEARTBEAT_URL 告警')
  assert.ok(
    !hits[0].includes('uuid-placeholder'),
    '告警绝不能回显配置值（心跳 URL 常含 uuid 型密钥）',
  )
})

test('心跳：关闭状态下 → 不发任何请求（即便 healthy=true）', async () => {
  const calls: string[] = []
  const f = (async (url: unknown) => {
    calls.push(String(url))
    return { ok: true } as unknown as Response
  }) as unknown as typeof fetch
  assert.equal(await pingHeartbeat(true, 1_000_000, f), false)
  assert.deepEqual(calls, [])
})
