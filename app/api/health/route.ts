import { NextResponse } from 'next/server'

// 存活探针（liveness）：容器/反代/HEALTHCHECK 判断进程是否活着。
// 无鉴权、无副作用、只回 {ok:true}——不带版本/uptime/DB 状态/任何配置信息
// （避免泄露 + 减少攻击面；readiness+DB 探活留 R2）。
export const dynamic = 'force-dynamic' // 防静态化：每次请求都真实命中进程

export async function GET() {
  return NextResponse.json({ ok: true })
}
