import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// R7-P2③（codex R6 指出）：realClient.inspect() 的「不抛的失败路径」必须改成抛错
//
// 问题：lib/cpa.ts 的 realClient.inspect() 有两条路径在**巡检根本没跑成**时返回空数组：
//   ① POST /codex-inspection/run 返回 200 但体里没有 run.id（cpamp 侧建不起巡检任务）；
//   ② 轮询 30 轮（约 30s）后 run 仍未 completed、results 仍未出现 → `detail.results ?? []`。
// 对接-R3b 又用脱敏真实证据补出第三条：首次 GET 仍是 running，却已带 `results: []`；
// JavaScript 把空数组视为 truthy，旧条件会立即结束轮询，错过后续 completed 的最终结果。
// 调用方（collect.ts 的 processPending / checkPooledHealth）拿到 [] 就一个号都不处理，却留
// inspectFailed=false ⇒ dead-man 心跳照报健康，而收号/存活巡检链路实际已断，且全程静默。
//
// 修复层次（本轮的关键判断）：收口在 **cpa.ts** 而不是 collect.ts。
//   空数组在调用方那里是三义的——「没跑成」「跑完零结果」「跑完但没覆盖到目标号」。
//   在 collect.ts 按 `probes.length === 0` 判故障会把后两者一并误报成 CPA 挂了 → 心跳恒不发。
//   （已有两条测试钉住这一点：inspection-mapping「inspect 正常（哪怕本轮一个号都没通过）」、
//    health-dashboard「R4-P2③ 反向」——本轮先按报告点位改 collect.ts，正是被这两条测试拦下的。）
//   只有 cpa.ts 这一层还分得清，故在这里把「没跑成」转成异常，让调用方现成的 catch
//   （不可观测 → 本轮跳过 + 置健康信号 + 绝不误停/误退回）自动接住，collect.ts 一个字不用改。
//
// 走真实客户端路径：MOCK=false + 桩 fetch（env 在 import 时读取，先设好再动态 import）。
// 与 MOCK=true 的测试**分文件**（env.mock 每进程固定一次）。不触 DB / 不触真实网络。
// ============================================================================

let cpa: typeof import('../lib/cpa.ts').cpa
let CPA_UNAVAILABLE: string

before(async () => {
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = '12345678901234567890123456789012'
  process.env.CPA_BASE_URL = 'http://cpa.test'
  process.env.CPA_MANAGEMENT_KEY = 'k'
  const mod = await import('../lib/cpa.ts')
  cpa = mod.cpa
  CPA_UNAVAILABLE = mod.CPA_UNAVAILABLE
})

// 桩 fetch：按「POST run」/「GET runs/<id>」两类请求分别给答案。
// 记录调用次数以便断言轮询行为。
function stubFetch(opts: {
  runBody: unknown
  runDetail?: (i: number) => unknown
}): { calls: () => number; runCalls: () => number } {
  let runs = 0
  let polls = 0
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/codex-inspection/run')) {
      runs++
      return new Response(JSON.stringify(opts.runBody), { status: 200 })
    }
    const body = opts.runDetail ? opts.runDetail(polls++) : {}
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { calls: () => polls, runCalls: () => runs }
}

// 轮询间隔在测试中立即兑现，避免为 30 轮上限真实等待约 30 秒。仅改测试时钟，不给生产接口
// 增加轮次/间隔注入参数。
async function withoutPollingDelay<T>(fn: () => Promise<T>): Promise<T> {
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: () => void) => realTimeout(callback, 0)) as typeof globalThis.setTimeout
  try {
    return await fn()
  } finally {
    globalThis.setTimeout = realTimeout
  }
}

// ① POST run 返回 200 但没有 run.id → 必须抛，不能返回 []
test('R7-P2③：run 未返回 run.id → inspect() 抛错（不再静默返回空数组）', async () => {
  stubFetch({ runBody: { run: {} } }) // 200 但体里没有 id
  const err = await cpa.inspect().then(
    () => null,
    (e) => e as Error,
  )
  assert.ok(
    err,
    '🔴 巡检任务根本没建起来 = 不可观测，必须抛；返回 [] 会让调用方判「巡检正常、零结果」→ 心跳假绿',
  )
  assert.equal(err.message, CPA_UNAVAILABLE, '§8：对外统一中性文案，不透传 cpamp 内部细节')
})

// ①b run 字段整个缺失（另一种形状的同一故障）
test('R7-P2③：run 响应体整个缺 run 字段 → 同样抛错', async () => {
  stubFetch({ runBody: {} })
  const err = await cpa.inspect().then(() => null, (e) => e as Error)
  assert.ok(err, '🔴 同属「巡检没建起来」，不得静默空返回')
  assert.equal(err.message, CPA_UNAVAILABLE)
})

// ② 轮询 30 轮后 run 仍未 completed、results 仍未出现 → 必须抛
//
// ⚠️ 实现里每轮之间 sleep(1000)，跑满 30 轮是 ~30s——真等会让整个测试套变慢一倍。故桩掉
//    setTimeout 让 sleep 立即兑现（只在本例内，跑完还原）。不给生产代码加「轮次/间隔可注入」
//    的测试专用参数：那是为测试改产品接口，本项目一贯避免。
test('R7-P2③：轮询到上限仍未就绪 → inspect() 抛错（不再返回 results ?? []）', async () => {
  const s = stubFetch({
    runBody: { run: { id: 7 } },
    // 恒「运行中」：既不 completed 也不带 results —— 修复前 30 轮后落到 `detail.results ?? []` 返回 []
    runDetail: () => ({ run: { status: 'running' } }),
  })
  const err = await withoutPollingDelay(() => cpa.inspect().then(() => null, (e) => e as Error))
  assert.ok(
    err,
    '🔴 结果永不就绪 = 不可观测，必须抛；返回 [] 会让 dead-man 在巡检瘫痪时保持沉默',
  )
  assert.equal(err.message, CPA_UNAVAILABLE)
  assert.equal(s.calls(), 30, '前置：确实跑满了 30 轮轮询上限才判失败')
})

// A. `results` 字段存在不等于 run 已完成：首次 running + [] 必须继续轮询，直到 completed。
test('R3b-A：running + results=[] 不提前结束；completed 后返回最终映射结果', async () => {
  const s = stubFetch({
    runBody: { run: { id: 71 } },
    runDetail: (i) =>
      i === 0
        ? { run: { status: 'running' }, results: [] }
        : {
            run: { status: 'completed' },
            results: [
              { accountId: 'final-account', action: 'keep', statusCode: 200, provider: 'codex', planType: 'plus' },
            ],
          },
  })

  const r = await withoutPollingDelay(() => cpa.inspect())

  assert.equal(s.calls(), 2, '首次 running + 空结果必须继续 GET，不能把空数组 truthy 当完成')
  assert.equal(s.runCalls(), 1, '一个 inspect() 调用只能创建一个 inspection run')
  assert.deepEqual(r.map((x) => x.accountId), ['final-account'])
  assert.equal(r[0].decision, 'ok')
  assert.equal(r[0].plan, 'plus')
})

// B. 空数组即使每轮都存在，也不能把未完成 run 伪装成“完成但零结果”。
test('R3b-B：running + results=[] 持续到轮询上限 → 抛 CPA_UNAVAILABLE', async () => {
  const s = stubFetch({
    runBody: { run: { id: 72 } },
    runDetail: () => ({ run: { status: 'running' }, results: [] }),
  })

  const err = await withoutPollingDelay(() => cpa.inspect().then(() => null, (e) => e as Error))

  assert.ok(err, '未到成功终态时必须 fail-closed，不能静默返回 []')
  assert.equal(err.message, CPA_UNAVAILABLE)
  assert.equal(s.calls(), 30, '必须轮询到既定上限后才报告不可观测')
  assert.equal(s.runCalls(), 1, '轮询补救不得再创建第二个 inspection run')
})

test('R3b：failed/cancelled 均不是成功终态，即使带 results=[] 也必须 fail-closed', async () => {
  for (const status of ['failed', 'cancelled']) {
    const s = stubFetch({
      runBody: { run: { id: status === 'failed' ? 74 : 75 } },
      runDetail: () => ({ run: { status }, results: [] }),
    })

    const err = await withoutPollingDelay(() => cpa.inspect().then(() => null, (e) => e as Error))

    assert.ok(err, `${status} 不得正常返回`)
    assert.equal(err.message, CPA_UNAVAILABLE)
    assert.equal(s.calls(), 30, `${status} 未获成功终态，必须在既定上限后 fail-closed`)
    assert.equal(s.runCalls(), 1, `${status} 轮询期间不得重建 run`)
  }
})

// ③ 🔴 反向回归（本条不能少）：**跑完了、本轮零结果**仍须正常返回 []，绝不能抛。
//    没有这条，把 inspect() 改成「一律抛」也能让上面三条全绿——而那会让号刚落、cpamp 侧还没
//    登记的正常场景被误报成 CPA 故障，心跳恒不发（正是 collect.ts 那层改法的病）。
test('R7-P2③ 反向：巡检跑完但零结果 → 正常返回 []，不抛（不误报故障）', async () => {
  stubFetch({
    runBody: { run: { id: 8 } },
    runDetail: () => ({ run: { status: 'completed' }, results: [] }),
  })
  const r = await cpa.inspect()
  assert.deepEqual(r, [], '🔴 跑完零结果是正常情况（号刚落/未登记），必须原样返回空数组')
})

// ③b 反向回归：completed 且有结果 → 正常映射返回
test('R7-P2③ 反向：巡检跑完且有结果 → 正常返回映射结果', async () => {
  stubFetch({
    runBody: { run: { id: 9 } },
    runDetail: () => ({
      run: { status: 'completed' },
      results: [{ accountId: 'a1', action: 'keep', status: 'ok', provider: 'codex', planType: 'plus' }],
    }),
  })
  const r = await cpa.inspect()
  assert.equal(r.length, 1, '正常结果必须照常返回')
  assert.equal(r[0].accountId, 'a1')
})

// D. 非空结果也可能只是运行中的 partial；只能在 completed 后返回最终集合。
test('R3b-D：running + 非空 partial results 不提前返回；completed 后返回最终集合', async () => {
  const s = stubFetch({
    runBody: { run: { id: 73 } },
    runDetail: (i) =>
      i === 0
        ? {
            run: { status: 'running' },
            results: [
              { accountId: 'partial-account', action: 'keep', statusCode: 200, provider: 'codex', planType: 'plus' },
            ],
          }
        : {
            run: { status: 'completed' },
            results: [
              { accountId: 'partial-account', action: 'keep', statusCode: 200, provider: 'codex', planType: 'plus' },
              { accountId: 'final-account-2', action: 'keep', statusCode: 200, provider: 'codex', planType: 'plus' },
            ],
          },
  })

  const r = await withoutPollingDelay(() => cpa.inspect())

  assert.equal(s.calls(), 2, 'running 的非空结果也不能证明集合已经最终化')
  assert.equal(s.runCalls(), 1, '等待最终集合期间不得创建第二个 inspection run')
  assert.deepEqual(r.map((x) => x.accountId), ['partial-account', 'final-account-2'])
})
