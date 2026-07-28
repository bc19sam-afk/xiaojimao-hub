import { NextResponse } from 'next/server'
import { readinessResultAsync } from '@/lib/readiness'

// 就绪探针（readiness）：依赖可用、schema 可供当前进程安全读写时才允许接流量。
// 与 /api/health 的进程存活语义严格分开；失败只回脱敏摘要。
export const dynamic = 'force-dynamic'

export async function GET() {
  const result = await readinessResultAsync(async () => {
    // 每次请求都走 fresh connection；不能让坏库首次求值的 singleton rejection
    // 被 ESM cache 固化为永久 503。
    const { assertReadinessDatabase } = await import('@/lib/readiness-probe')
    assertReadinessDatabase()
  })
  return NextResponse.json(result.body, { status: result.status })
}
