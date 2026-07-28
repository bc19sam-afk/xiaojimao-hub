import { NextResponse } from 'next/server'
import { readinessResultAsync } from '@/lib/readiness'

// 就绪探针（readiness）：依赖可用、schema 可供当前进程安全读写时才允许接流量。
// 与 /api/health 的进程存活语义严格分开；失败只回脱敏摘要。
export const dynamic = 'force-dynamic'

export async function GET() {
  const result = await readinessResultAsync(async () => {
    // 冷启动坏库时，db.ts 的模块求值可能抛错；必须在 handler 内捕获并稳定返回 503。
    const { db } = await import('@/lib/db')
    db.assertReady()
  })
  return NextResponse.json(result.body, { status: result.status })
}
