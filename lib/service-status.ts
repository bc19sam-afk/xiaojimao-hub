export type ServiceAvailability = 'loading' | 'available' | 'unavailable' | 'unknown'

export interface ServiceProbeResult {
  state: ServiceAvailability
  summary: string
  checkedAt: number | null
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function loadingServiceProbe(): ServiceProbeResult {
  return { state: 'loading', summary: '正在检查', checkedAt: null }
}

function publicUnavailableSummary(
  endpoint: '/api/health' | '/api/ready',
  body: unknown,
): string {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined
  if (endpoint === '/api/ready' && code === 'DATABASE_NOT_READY') return '数据库尚未就绪'
  if (endpoint === '/api/health' && code === 'PROCESS_NOT_LIVE') return '进程探针报告不可用'
  return endpoint === '/api/health' ? '进程状态检查不可用' : '数据库就绪检查不可用'
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}

async function readJson(response: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await response.json() }
  } catch (error) {
    if (isAbortError(error)) throw error
    if (error instanceof SyntaxError) return { ok: false }
    throw error
  }
}

export async function probeServiceEndpoint(
  endpoint: '/api/health' | '/api/ready',
  fetcher: FetchLike = fetch,
  timeoutMs = 5_000,
  now: () => number = Date.now,
): Promise<ServiceProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetcher(endpoint, { cache: 'no-store', signal: controller.signal })
    const parsed = await readJson(response)
    const checkedAt = now()

    if (!parsed.ok) {
      if (!response.ok) {
        return {
          state: 'unavailable',
          summary: publicUnavailableSummary(endpoint, undefined),
          checkedAt,
        }
      }
      return { state: 'unknown', summary: '检查响应格式异常', checkedAt }
    }
    const body = parsed.body

    if (!response.ok) {
      return {
        state: 'unavailable',
        summary: publicUnavailableSummary(endpoint, body),
        checkedAt,
      }
    }

    if (!body || typeof body !== 'object' || typeof (body as { ok?: unknown }).ok !== 'boolean') {
      return { state: 'unknown', summary: '检查响应格式异常', checkedAt }
    }

    if ((body as { ok: boolean }).ok) {
      return { state: 'available', summary: '服务可用', checkedAt }
    }

    return {
      state: 'unavailable',
      summary: publicUnavailableSummary(endpoint, body),
      checkedAt,
    }
  } catch (error) {
    return {
      state: 'unknown',
      summary: controller.signal.aborted || isAbortError(error) ? '检查超时' : '无法完成检查',
      checkedAt: now(),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeSystemStatus(
  fetcher: FetchLike = fetch,
  timeoutMs = 5_000,
  now: () => number = Date.now,
): Promise<{ liveness: ServiceProbeResult; readiness: ServiceProbeResult }> {
  const [liveness, readiness] = await Promise.all([
    probeServiceEndpoint('/api/health', fetcher, timeoutMs, now),
    probeServiceEndpoint('/api/ready', fetcher, timeoutMs, now),
  ])
  return { liveness, readiness }
}
