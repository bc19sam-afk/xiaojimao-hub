// 统一的外部 HTTP 边界：有界等待、固定分类日志、绝不记录 URL/请求体/响应体/原始错误。
// 调用方只传代码内固定的 service/operation 标签；任何来自用户或外部系统的值都不得放进标签。

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000

export type OutboundFailureKind =
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_json'
  | 'invalid_shape'

export class OutboundRequestError extends Error {
  readonly name = 'OutboundRequestError'
  readonly service: string
  readonly operation: string
  readonly kind: OutboundFailureKind
  readonly status?: number

  constructor(
    service: string,
    operation: string,
    kind: OutboundFailureKind,
    status?: number,
  ) {
    super('外部服务请求失败')
    this.service = service
    this.operation = operation
    this.kind = kind
    this.status = status
  }
}

function logFailure(
  service: string,
  operation: string,
  kind: OutboundFailureKind,
  status?: number,
): void {
  const suffix = status === undefined ? '' : ` status=${status}`
  console.error(`[outbound] ${service}.${operation} ${kind}${suffix}`)
}

function fail(
  service: string,
  operation: string,
  kind: OutboundFailureKind,
  status?: number,
): never {
  logFailure(service, operation, kind, status)
  throw new OutboundRequestError(service, operation, kind, status)
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

interface OutboundOptions {
  service: string
  operation: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

async function requestText(
  input: string | URL,
  init: RequestInit,
  options: OutboundOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS
  const controller = new AbortController()
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    let response: Response
    try {
      response = await fetchImpl(input, { ...init, signal })
    } catch (error) {
      if (isAbort(error, signal)) {
        fail(options.service, options.operation, 'timeout')
      }
      fail(options.service, options.operation, 'network')
    }

    if (!response.ok) {
      // 不读取、更不记录外部响应体；只保留状态码供运维分流。
      fail(options.service, options.operation, 'http', response.status)
    }

    try {
      // 定时器覆盖 body 消费；只在 headers 到达时清 timer 会让停滞 body 永久挂住。
      return await response.text()
    } catch (error) {
      if (isAbort(error, signal)) {
        fail(options.service, options.operation, 'timeout')
      }
      fail(options.service, options.operation, 'network')
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function outboundJson(
  input: string | URL,
  init: RequestInit,
  options: OutboundOptions,
): Promise<unknown> {
  const text = await requestText(input, init, options)
  if (!text) fail(options.service, options.operation, 'invalid_json')
  try {
    return JSON.parse(text)
  } catch {
    fail(options.service, options.operation, 'invalid_json')
  }
}

export async function outboundOk(
  input: string | URL,
  init: RequestInit,
  options: OutboundOptions,
): Promise<void> {
  await requestText(input, init, options)
}

export function invalidOutboundShape(service: string, operation: string): never {
  fail(service, operation, 'invalid_shape')
}
