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

// ============================================================================
// P6-R2 复审第 7 条：首检「卡住」（skipped）也要掐掉心跳
//
// processPending 的 running 锁没释放时返回 { skipped:true } 而**不抛**——上一轮吊死在某个 await
// （cpamp 连接卡住等）就会一直如此。tick 只 catch 异常的话 healthy 恒 true、心跳照打，
// dead-man 在「worker 真的不干活了」时反而保持沉默，正是它该报警的那个场景。
// ============================================================================

test('复审7：首检 skipped（锁未释放＝可能卡死）→ 判不健康 → 不发心跳', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    pendingIsHealthy({ skipped: true }),
    false,
    '🔴 首检被锁挡住时必须判不健康，否则 worker 卡死期间心跳照打、dead-man 永不告警',
  )
  // 串到真实心跳链路上确认确实不发
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({ skipped: true }), 1_000_000, f), false)
  assert.deepEqual(calls, [], '首检卡住时绝不能发心跳')
})

test('复审7：首检正常跑完 → 判健康 → 正常发心跳', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(pendingIsHealthy({ checked: 3, activated: 1, rejected: 0 }), true)
  assert.equal(pendingIsHealthy({ checked: 0, activated: 0, rejected: 0 }), true, '没号可检也算正常')
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({ activated: 0 }), 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})

// ⚠️ 部分采纳的边界（别回退）：另两段的 skipped **不并进** healthy。
//    它们的 skipped 是正常节流而非卡死——实测 8s tick、一天 10800 轮下，checkPooledHealth 因
//    5 分钟节流 skip 97.33%、settleDailyUsage 因 grace 窗 + 日闸 skip 99.99%。若一并并进去，
//    「三段同时真跑」一天只剩 1 轮，心跳一天最多 1 次，而外部 Period 建议 5 分钟 → 恒定误报。
test('复审7 边界：健康判据只看首检，不看另两段的节流 skipped', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  // pendingIsHealthy 的入参只有首检结果——签名本身就钉住了「另两段不参与」。
  // 这里额外钉住语义：一个「没做任何事但没被锁挡住」的首检结果仍算健康。
  assert.equal(pendingIsHealthy({ checked: 0, activated: 0, rejected: 0 }), true)
  assert.equal(pendingIsHealthy({}), true, 'skipped 缺省（undefined）＝没被挡住＝健康')
})

// ============================================================================
// P6-R2 复审三轮第 2 条消费侧：inspectFailed 健康信号
// ============================================================================

test('复审三轮2：inspectFailed=true → 判不健康 → 不发心跳', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    pendingIsHealthy({ checked: 5, activated: 0, rejected: 0, inspectFailed: true }),
    false,
    '🔴 CPA 巡检故障必须判不健康，否则 dead-man 心跳假绿',
  )
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({ inspectFailed: true }), 1_000_000, f), false)
  assert.deepEqual(calls, [], 'CPA 宕机期间绝不能发心跳')
})

test('复审三轮2：inspectFailed 缺省/false → 正常判健康', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(pendingIsHealthy({ checked: 0, activated: 0, rejected: 0 }), true, '本轮无活但 CPA 在线＝健康')
  assert.equal(pendingIsHealthy({ inspectFailed: false }), true)
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({ inspectFailed: false }), 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})

// ============================================================================
// P6-R2 复审三轮第 3 条消费侧：settleIsHealthy 只看 lockHeld
// ============================================================================

test('复审三轮3：lockHeld=true → 判不健康 → 不发心跳', async () => {
  const { settleIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    settleIsHealthy({ skipped: true, lockHeld: true }),
    false,
    '🔴 结算锁卡死必须判不健康',
  )
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(settleIsHealthy({ lockHeld: true }), 1_000_000, f), false)
  assert.deepEqual(calls, [], '结算卡死期间绝不能发心跳')
})

test('复审三轮3：节流 skipped（无 lockHeld）→ 判健康', async () => {
  const { settleIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    settleIsHealthy({ skipped: true }),
    true,
    '🔴 节流 skip（grace 窗/日闸）≠ 卡死，误报会让心跳一天最多 1 次',
  )
  assert.equal(settleIsHealthy({ skipped: true, lockHeld: false }), true)
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(settleIsHealthy({ skipped: true }), 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})

test('复审三轮②-consumer：inspectFailed=true → pendingIsHealthy 判不健康 → 不发心跳', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(pendingIsHealthy({ inspectFailed: true }), false, '🔴 CPA 挂了必须判不健康')
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({ inspectFailed: true }), 1_000_000, f), false)
  assert.deepEqual(calls, [], 'CPA 不可用时绝不能发心跳')
})

test('复审三轮②-consumer：空闲 tick（无 inspectFailed）→ pendingIsHealthy 判健康', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(pendingIsHealthy({}), true, '空闲 tick 或探活成功 → 健康')
  assert.equal(pendingIsHealthy({ skipped: false }), true)
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({}), 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})

// ============================================================================
// P6-R2 R4② 存活巡检锁未传导到心跳
// ============================================================================

test('R4②：存活巡检 lockHeld=true → healthIsHealthy 判不健康 → 不发心跳', async () => {
  const { healthIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    healthIsHealthy({ skipped: true, lockHeld: true }),
    false,
    '🔴 存活巡检锁卡死必须判不健康',
  )
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(healthIsHealthy({ lockHeld: true }), 1_000_000, f), false)
  assert.deepEqual(calls, [], '存活巡检卡死期间绝不能发心跳')
})

test('R4②：存活巡检节流 skipped（无 lockHeld）→ healthIsHealthy 判健康', async () => {
  const { healthIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    healthIsHealthy({ skipped: true }),
    true,
    '🔴 节流 skip（5 分钟节流）≠ 卡死，误报会让心跳恒不发',
  )
  assert.equal(healthIsHealthy({ skipped: true, lockHeld: false }), true)
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(healthIsHealthy({ skipped: true }), 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})

// ============================================================================
// P6-R2 R6② 存活巡检 CPA 失败未传导到心跳
// ============================================================================

test('R6②：存活巡检 inspectFailed=true → healthIsHealthy 判不健康 → 不发心跳', async () => {
  const { healthIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    healthIsHealthy({ inspectFailed: true }),
    false,
    '🔴 CPA 巡检接口故障必须判不健康',
  )
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(healthIsHealthy({ inspectFailed: true }), 1_000_000, f), false)
  assert.deepEqual(calls, [], 'CPA 巡检接口故障期间绝不能发心跳')
})

test('R6②：存活巡检无 pooled 号（inspectFailed 缺省 undefined）→ healthIsHealthy 判健康', async () => {
  const { healthIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    healthIsHealthy({ skipped: false }),
    true,
    '🔴 本轮无 pooled 号（inspectFailed 缺省）≠ 不健康，误报会让心跳恒不发',
  )
  assert.equal(healthIsHealthy({}), true)
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(healthIsHealthy({}), 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})

// ============================================================================
// P6-R2 R6③ 回归（codex R5）：CPA 写操作失败未判不健康
//
// setDisabled/deleteAuthFile/setPriority 抛错时，enterPool/rejectBack 内部 catch 住、留行待重试，
// **不抛**（收号纪律不变）。processPending 此前只回传 activated/rejected 计数、无失败信号 →
// worker 的 healthy 恒 true → 心跳照打，而 CPA 写端点故障会阻塞所有激活/拒绝。
// 修复：额外传播 writeFailed 健康信号，pendingIsHealthy 判据据此掐心跳。
// ============================================================================

test('R6③：writeFailed=true → pendingIsHealthy 判不健康 → 不发心跳', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    pendingIsHealthy({ writeFailed: true }),
    false,
    '🔴 CPA 写操作失败必须判不健康',
  )
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({ writeFailed: true }), 1_000_000, f), false)
  assert.deepEqual(calls, [], 'CPA 写操作故障期间绝不能发心跳')
})

test('R6③：首检无待检号（writeFailed 缺省 undefined）→ pendingIsHealthy 判健康', async () => {
  const { pendingIsHealthy } = await import('../lib/worker.ts')
  assert.equal(
    pendingIsHealthy({ skipped: false }),
    true,
    '🔴 本轮无待检号（writeFailed 缺省）≠ 不健康，误报会让心跳恒不发',
  )
  assert.equal(pendingIsHealthy({}), true)
  const { f, calls } = spyFetch()
  assert.equal(await pingHeartbeat(pendingIsHealthy({}), 1_000_000, f), true)
  assert.deepEqual(calls, [HB_URL])
})


// ============================================================================
// R6-P2⑤（codex R5 终审）：非 2xx 静默当成功
//
// fetch 只在网络层失败时 reject，HTTP 错误状态是正常 resolve 的（404/401/5xx 等）。修复前
// 任何状态码都返回 true、日志一片祥和，而监视器根本没收到 ping（URL/token 错了/监视器自己挂了）。
// 运维只会在监视器超时告警后来查日志、却看不到异常——因为本地恰恰按「发送成功」记的，完全误导。
//
// 修复：判 res.ok，非 2xx 记 warn + 返回 false。同时脱敏：只记状态码，不回显 URL 或响应体
// （响应体可能复述 URL/token）。
// ============================================================================

test('R6-P2⑤：404 → 返回 false 且记 warn（不静默当成功）', async () => {
  const { f } = spyFetch(async () => ({ ok: false, status: 404 }) as unknown as Response)
  const logs: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    assert.equal(await pingHeartbeat(true, 1_000_000, f), false, '🔴 非 2xx 必须返回 false')
  } finally {
    console.warn = origWarn
  }
  assert.equal(logs.length, 1, '必须记一条 warn')
  assert.match(logs[0], /HTTP 404/, '🔴 状态码必须出现在日志里')
  assert.doesNotMatch(logs[0], /uuid-placeholder/, '🔴 URL 不得泄漏（§8 脱敏）')
})

test('R6-P2⑤：500 → 返回 false 且记 warn', async () => {
  const { f } = spyFetch(async () => ({ ok: false, status: 500 }) as unknown as Response)
  const logs: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    assert.equal(await pingHeartbeat(true, 1_000_000, f), false)
  } finally {
    console.warn = origWarn
  }
  assert.match(logs[0], /HTTP 500/)
  assert.doesNotMatch(logs[0], /uuid-placeholder/)
})

test('R6-P2⑤：401 → 返回 false 且记 warn', async () => {
  const { f } = spyFetch(async () => ({ ok: false, status: 401 }) as unknown as Response)
  const logs: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    assert.equal(await pingHeartbeat(true, 1_000_000, f), false)
  } finally {
    console.warn = origWarn
  }
  assert.match(logs[0], /HTTP 401/)
})

test('R6-P2⑤ 反向：200 → 返回 true 且不记 warn', async () => {
  const { f, calls } = spyFetch(async () => ({ ok: true, status: 200 }) as unknown as Response)
  const logs: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    assert.equal(await pingHeartbeat(true, 1_000_000, f), true, '🔴 2xx 必须返回 true')
  } finally {
    console.warn = origWarn
  }
  assert.deepEqual(logs, [], '成功时不得记 warn')
  assert.deepEqual(calls, [HB_URL])
})

test('R6-P2⑤ 反向：204 → 返回 true', async () => {
  const { f } = spyFetch(async () => ({ ok: true, status: 204 }) as unknown as Response)
  assert.equal(await pingHeartbeat(true, 1_000_000, f), true)
})
