import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readinessResult } from '@/lib/readiness'

// 就绪探针（readiness）：依赖可用、schema 可供当前进程安全读写时才允许接流量。
// 与 /api/health 的进程存活语义严格分开；失败只回脱敏摘要。
export const dynamic = 'force-dynamic'

export async function GET() {
  const result = readinessResult(() => db.assertReady())
  return NextResponse.json(result.body, { status: result.status })
}
