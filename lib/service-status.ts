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

function safeSummary(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const summary = (body as { summary?: unknown }).summary
  if (typeof summary !== 'string') return ''
  return summary.replace(/\s+/g, ' ').trim().slice(0, 80)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
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
    const checkedAt = now()
    const body = await readJson(response)

    if (!response.ok) {
      return {
        state: 'unavailable',
        summary: safeSummary(body) || `检查返回 HTTP ${response.status}`,
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
      summary: safeSummary(body) || '服务报告不可用',
      checkedAt,
    }
  } catch {
    return {
      state: 'unknown',
      summary: controller.signal.aborted ? '检查超时' : '无法完成检查',
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
