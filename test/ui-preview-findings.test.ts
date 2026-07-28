import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redemptionStatusView } from '../lib/redemption-status.ts'
import { probeServiceEndpoint, probeSystemStatus } from '../lib/service-status.ts'

test('兑换状态展示：pending / failed / fulfilled / unknown 使用明确中文与非纯颜色符号', () => {
  assert.deepEqual(redemptionStatusView('pending'), {
    key: 'pending', label: '处理中', symbol: '…', description: '兑换请求正在处理',
  })
  assert.deepEqual(redemptionStatusView('failed'), {
    key: 'failed', label: '兑换失败', symbol: '!', description: '本次兑换未完成',
  })
  assert.deepEqual(redemptionStatusView('fulfilled'), {
    key: 'fulfilled', label: '已完成', symbol: '✓', description: '兑换已完成',
  })
  for (const value of [undefined, null, '', 'mystery']) {
    assert.deepEqual(redemptionStatusView(value), {
      key: 'unknown', label: '状态未知', symbol: '?', description: '暂时无法确认兑换状态',
    })
  }
})

test('服务探针：成功、非 2xx、malformed 与网络失败分别安全归类', async () => {
  const now = () => 123
  const ok = await probeServiceEndpoint('/api/health', async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 }), 100, now)
  assert.equal(ok.state, 'available')
  assert.equal(ok.checkedAt, 123)

  const down = await probeServiceEndpoint('/api/ready', async () =>
    new Response(JSON.stringify({
      ok: false,
      code: 'DATABASE_NOT_READY',
      summary: 'SQLite open failed at /private/tmp/app.db token=secret-token',
      detail: 'Error: socket failed\n at internal-host.example',
    }), { status: 503 }), 100, now)
  assert.equal(down.state, 'unavailable')
  assert.equal(down.summary, '数据库尚未就绪')
  for (const secret of ['/private/tmp/app.db', 'secret-token', 'internal-host.example', 'socket failed']) {
    assert.equal(JSON.stringify(down).includes(secret), false)
  }

  const reportedDown = await probeServiceEndpoint('/api/ready', async () =>
    new Response(JSON.stringify({ ok: false, code: 'DATABASE_NOT_READY' }), { status: 200 }), 100, now)
  assert.equal(reportedDown.state, 'unavailable')
  assert.equal(reportedDown.summary, '数据库尚未就绪')

  const untrustedSummary = await probeServiceEndpoint('/api/health', async () =>
    new Response(JSON.stringify({
      ok: false,
      code: 'UNRECOGNIZED_INTERNAL_CODE',
      summary: '/srv/app.db token=leak stack=secret host=db.internal',
    }), { status: 500 }), 100, now)
  assert.equal(untrustedSummary.state, 'unavailable')
  assert.equal(untrustedSummary.summary, '进程状态检查不可用')
  assert.equal(JSON.stringify(untrustedSummary).includes('/srv/app.db'), false)

  const malformed = await probeServiceEndpoint('/api/ready', async () =>
    new Response('not-json', { status: 200 }), 100, now)
  assert.equal(malformed.state, 'unknown')
  assert.equal(malformed.summary, '检查响应格式异常')

  const malformedUnavailable = await probeServiceEndpoint('/api/ready', async () =>
    new Response('<html>proxy error with /private/path token=secret</html>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    }), 100, now)
  assert.equal(malformedUnavailable.state, 'unavailable')
  assert.equal(malformedUnavailable.summary, '数据库就绪检查不可用')
  assert.equal(JSON.stringify(malformedUnavailable).includes('/private/path'), false)

  const wrongShape = await probeServiceEndpoint('/api/ready', async () =>
    new Response(JSON.stringify({ status: 'ready' }), { status: 200 }), 100, now)
  assert.equal(wrongShape.state, 'unknown')
  assert.equal(wrongShape.summary, '检查响应格式异常')

  const network = await probeServiceEndpoint('/api/health', async () => {
    throw new Error('network secret')
  }, 100, now)
  assert.equal(network.state, 'unknown')
  assert.equal(network.summary, '无法完成检查')
  assert.equal(JSON.stringify(network).includes('secret'), false)
})

test('服务探针：body 阶段 AbortError/停滞归 timeout，传输错误不误报 malformed', async () => {
  const stalled = await probeServiceEndpoint('/api/ready', async (_input, init) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('body aborted', 'AbortError'))
      }, { once: true })
    }),
  } as Response), 5, () => 321)
  assert.equal(stalled.state, 'unknown')
  assert.equal(stalled.summary, '检查超时')

  const bodyAbort = await probeServiceEndpoint('/api/ready', async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new DOMException('body aborted', 'AbortError') },
  } as Response), 100, () => 322)
  assert.equal(bodyAbort.state, 'unknown')
  assert.equal(bodyAbort.summary, '检查超时')

  const bodySocket = await probeServiceEndpoint('/api/ready', async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new TypeError('socket reset by internal-host token=secret') },
  } as Response), 100, () => 323)
  assert.equal(bodySocket.state, 'unknown')
  assert.equal(bodySocket.summary, '无法完成检查')
  assert.equal(JSON.stringify(bodySocket).includes('internal-host'), false)
})

test('服务探针：timeout 为 unknown，health 与 ready 独立请求且互不推断', async () => {
  const timedOut = await probeServiceEndpoint('/api/health', async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }), 5, () => 456)
  assert.equal(timedOut.state, 'unknown')
  assert.equal(timedOut.summary, '检查超时')

  const requested: string[] = []
  const result = await probeSystemStatus(async (input) => {
    const url = String(input)
    requested.push(url)
    if (url === '/api/health') throw new Error('offline')
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }, 100, () => 789)
  assert.deepEqual(requested.sort(), ['/api/health', '/api/ready'])
  assert.equal(result.liveness.state, 'unknown')
  assert.equal(result.readiness.state, 'available')
})
