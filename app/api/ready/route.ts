import { NextResponse } from 'next/server'
import { readinessResultAsync } from '@/lib/readiness'

// 就绪探针（readiness）：同时验证 canonical schema、快速写能力、常驻连接与磁盘路径身份。
// 与 /api/health 的进程存活语义严格分开；失败只回固定脱敏摘要，不能作为重启依据。
export const dynamic = 'force-dynamic'

export async function GET() {
  const result = await readinessResultAsync(async () => {
    // 先走独立短超时 fresh connection，再核对 resident/disk inode；坏库首次求值不能
    // 被 ESM cache 固化为永久 503，外部写锁也不能用业务连接的 5s timeout 阻塞 liveness。
    const { assertReadinessDatabase } = await import('@/lib/readiness-probe')
    await assertReadinessDatabase()
  })
  return NextResponse.json(result.body, { status: result.status })
}
