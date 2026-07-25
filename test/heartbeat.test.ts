import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================================
// P6-R2 ④：dead-man 心跳（lib/worker.ts 的 pingHeartbeat）—— 已配置合法 URL 的情形
//
// 规则：三段全成才 ping；节流至少 5 分钟一次；fetch 失败只 warn 不外抛；未配置＝空操作。
//
// ⚠️ env 是模块级单例、每进程固定 ⇒ 「URL 非法视为关闭」必须另开一个测试文件
//    （见 test/heartbeat-disabled.test.ts），同项目既有的「MOCK 按文件分」纪律。
// ⚠️ 隔离红线：worker → collect/settle → db，故必须先设 DB_PATH 到临时目录再动态 import。
// ⚠️ 零真实网络：fetch 全程注入桩。
// ============================================================================

const HB_URL = 'https://hc-ping.example/uuid-placeholder'
const THROTTLE_MS = 5 * 60_000

let pingHeartbeat: typeof import('../lib/worker.ts').pingHeartbeat
let resetThrottle: typeof import('../lib/worker.ts').__resetHeartbeatThrottle
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-hb-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  process.env.HEARTBEAT_URL = HB_URL
  const w = await import('../lib/worker.ts')
  pingHeartbeat = w.pingHeartbeat
  resetThrottle = w.__resetHeartbeatThrottle
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => resetThrottle())

// 记录调用的桩 fetch
function spyFetch(impl?: (url: string) => Promise<unknown>) {
  const calls: string[] = []
  const f = (async (url: unknown) => {
    calls.push(String(url))
    if (impl) return impl(String(url))
    return { ok: true } as unknown as Response
  }) as unknown as typeof fetch
  return { f, calls }
}

test('心跳：三段全成 → ping 一次，打到配置的 URL', async () => {
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(true, 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})

// 🔴 核心：本轮有段抛错（healthy=false）就不 ping——让外部服务超时告警。
// 若这里误 ping，故障期间外部只会看到「一切正常」，dead-man 就白装了。
test('心跳：本轮有段抛错（healthy=false）→ 不 ping', async () => {
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(false, 1_000_000, f), false)
  assert.deepEqual(calls, [], 'healthy=false 时绝不能发心跳')
})

test('心跳：节流窗内（<5min）不重复 ping', async () => {
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(true, 1_000_000, f), true)
  // 默认 tick 8s：模拟窗内多轮
  for (let i = 1; i <= 30; i++) {
    assert.equal(await pingHeartbeat(true, 1_000_000 + i * 8_000, f), false)
  }
  assert.equal(await pingHeartbeat(true, 1_000_000 + THROTTLE_MS - 1, f), false)
  assert.equal(calls.length, 1, '5 分钟窗内只应发一次')
})

test('心跳：超过节流窗 → 再 ping 一次', async () => {
  const { f, calls } = spyFetch()
  await pingHeartbeat(true, 1_000_000, f)
  assert.equal(await pingHeartbeat(true, 1_000_000 + THROTTLE_MS, f), true)
  assert.equal(calls.length, 2)
})

// fetch 抛错（外部服务挂/网络不通）：只 warn，绝不外抛——心跳发不出去不能影响巡检。
test('心跳：fetch 抛错 → 返回 false、不外抛异常', async () => {
  const origWarn = console.warn
  const warns: unknown[][] = []
  console.warn = (...a: unknown[]) => warns.push(a)
  try {
    const { f, calls } = spyFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    let result: boolean | undefined
    await assert.doesNotReject(async () => {
      result = await pingHeartbeat(true, 1_000_000, f)
    })
    assert.equal(result, false)
    assert.equal(calls.length, 1)
    assert.equal(warns.length, 1, '应有且仅有一条告警')
  } finally {
    console.warn = origWarn
  }
})

// 外部服务持续挂时，节流照旧生效——不能每 8s 猛敲一次。
test('心跳：fetch 连续失败时仍受节流约束（不猛敲）', async () => {
  const origWarn = console.warn
  console.warn = () => {}
  try {
    const { f, calls } = spyFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    for (let i = 0; i < 20; i++) await pingHeartbeat(true, 1_000_000 + i * 8_000, f)
    assert.equal(calls.length, 1, '失败也只在窗口边界重试，不是每 tick 一次')
  } finally {
    console.warn = origWarn
  }
})

// 5s 超时：传给 fetch 的 signal 必须是未 abort 的 AbortSignal（真超时行为不卡真实时钟测）
test('心跳：带 AbortSignal（超时保护）', async () => {
  let sig: AbortSignal | undefined
  const f = (async (_url: unknown, init: unknown) => {
    sig = (init as { signal?: AbortSignal }).signal
    return { ok: true } as unknown as Response
  }) as unknown as typeof fetch
  await pingHeartbeat(true, 1_000_000, f)
  assert.ok(sig instanceof AbortSignal, '应传入 AbortSignal')
  assert.equal(sig.aborted, false)
})
