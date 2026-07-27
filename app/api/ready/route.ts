import { NextResponse } from 'next/server'
import { checkReady } from '@/lib/ready'

// 就绪探针（readiness）：DB 只读探活 + schema 版本匹配，判定逻辑在 lib/ready.ts（可单测）。
// 无鉴权、无副作用、响应体**只有 ok 字段**——不带版本/路径/配置/账号信息（§8 脱敏），
// 不就绪的具体原因只进服务端日志。就绪 200 {ok:true} / 未就绪 503 {ok:false}。
//
// ⚠️ 用途是「摘流量 + 告警」，不是重启依据：镜像 HEALTHCHECK 仍用 /api/health（liveness）——
// schema 落后时重启容器修不好问题，只会进重启 churn 循环。
export const dynamic = 'force-dynamic' // 防静态化：每次请求都真实命中进程

export async function GET() {
  const ok = await checkReady()
  return NextResponse.json({ ok }, { status: ok ? 200 : 503 })
}
