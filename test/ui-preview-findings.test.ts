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
    new Response(JSON.stringify({ ok: false, summary: '数据库尚未就绪', detail: 'secret' }), { status: 503 }), 100, now)
  assert.equal(down.state, 'unavailable')
  assert.equal(down.summary, '数据库尚未就绪')
  assert.equal(JSON.stringify(down).includes('secret'), false)

  const malformed = await probeServiceEndpoint('/api/ready', async () =>
    new Response('not-json', { status: 200 }), 100, now)
  assert.equal(malformed.state, 'unknown')

  const network = await probeServiceEndpoint('/api/health', async () => {
    throw new Error('network secret')
  }, 100, now)
  assert.equal(network.state, 'unknown')
  assert.equal(JSON.stringify(network).includes('secret'), false)
})

test('服务探针：timeout 为 unknown，health 与 ready 独立请求且互不推断', async () => {
  const timedOut = await probeServiceEndpoint('/api/health', async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }), 5, () => 456)
  assert.equal(timedOut.state, 'unknown')

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
