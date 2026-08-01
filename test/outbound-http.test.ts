import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  outboundJson,
  OutboundRequestError,
} from '../lib/outbound-http.ts'

const SECRET_URL = 'https://internal.example/token/secret-uuid'
const SECRET_BODY = 'response token=secret-body /private/path'

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; logs: string }> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  try {
    return { value: await fn(), logs: lines.join('\n') }
  } catch (error) {
    return { error, logs: lines.join('\n') }
  } finally {
    console.error = original
  }
}

test('统一出站请求：连接停滞按 timeout 中止，日志不含 URL/原始异常', async () => {
  const result = await captureErrors(() =>
    outboundJson(
      SECRET_URL,
      {},
      {
        service: 'test',
        operation: 'connect',
        timeoutMs: 5,
        fetchImpl: ((_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException(`aborted ${SECRET_URL}`, 'AbortError')),
              { once: true },
            )
          })) as typeof fetch,
      },
    ),
  )
  assert.ok(result.error instanceof OutboundRequestError)
  assert.equal(result.error.kind, 'timeout')
  assert.match(result.logs, /test\.connect timeout/)
  assert.equal(result.logs.includes(SECRET_URL), false)
})

test('统一出站请求：timeout 覆盖响应 body 消费，不只覆盖 headers', async () => {
  const result = await captureErrors(() =>
    outboundJson(
      SECRET_URL,
      {},
      {
        service: 'test',
        operation: 'body',
        timeoutMs: 5,
        fetchImpl: (async (_input, init) =>
          ({
            ok: true,
            status: 200,
            text: () =>
              new Promise<string>((_resolve, reject) => {
                init?.signal?.addEventListener(
                  'abort',
                  () => reject(new DOMException(`body ${SECRET_BODY}`, 'AbortError')),
                  { once: true },
                )
              }),
          }) as Response) as typeof fetch,
      },
    ),
  )
  assert.ok(result.error instanceof OutboundRequestError)
  assert.equal(result.error.kind, 'timeout')
  assert.equal(result.logs.includes(SECRET_BODY), false)
  assert.equal(result.logs.includes(SECRET_URL), false)
})

test('统一出站请求：HTTP 错误不读取或记录外部响应体', async () => {
  let bodyRead = false
  const result = await captureErrors(() =>
    outboundJson(
      SECRET_URL,
      {},
      {
        service: 'test',
        operation: 'http',
        fetchImpl: (async () =>
          ({
            ok: false,
            status: 503,
            text: async () => {
              bodyRead = true
              return SECRET_BODY
            },
          }) as Response) as typeof fetch,
      },
    ),
  )
  assert.ok(result.error instanceof OutboundRequestError)
  assert.equal(result.error.kind, 'http')
  assert.equal(result.error.status, 503)
  assert.equal(bodyRead, false)
  assert.match(result.logs, /test\.http http status=503/)
  assert.equal(result.logs.includes(SECRET_BODY), false)
  assert.equal(result.logs.includes(SECRET_URL), false)
})

test('统一出站请求：坏 JSON 只记固定 invalid_json 分类', async () => {
  const result = await captureErrors(() =>
    outboundJson(SECRET_URL, {}, {
      service: 'test',
      operation: 'json',
      fetchImpl: (async () => new Response(SECRET_BODY, { status: 200 })) as typeof fetch,
    }),
  )
  assert.ok(result.error instanceof OutboundRequestError)
  assert.equal(result.error.kind, 'invalid_json')
  assert.match(result.logs, /test\.json invalid_json/)
  assert.equal(result.logs.includes(SECRET_BODY), false)
})

test('统一出站请求：JSON 端点 200 空 body 也 fail-closed，不静默伪造成空对象', async () => {
  const result = await captureErrors(() =>
    outboundJson(SECRET_URL, {}, {
      service: 'test',
      operation: 'empty_json',
      fetchImpl: (async () => new Response('', { status: 200 })) as typeof fetch,
    }),
  )
  assert.ok(result.error instanceof OutboundRequestError)
  assert.equal(result.error.kind, 'invalid_json')
  assert.match(result.logs, /test\.empty_json invalid_json/)
})
