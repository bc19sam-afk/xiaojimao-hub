export interface ReadinessResult {
  status: 200 | 503
  body: { ok: true } | { ok: false; summary: string }
}

export function readinessResult(probe: () => void): ReadinessResult {
  try {
    probe()
    return { status: 200, body: { ok: true } }
  } catch {
    return { status: 503, body: { ok: false, summary: '数据库尚未就绪' } }
  }
}
