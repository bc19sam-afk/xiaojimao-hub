import { NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'

// 手动触发全局验证仅供管理员应急；生产正常路径是常驻 worker。
// 鉴权通过后才加载 collect/DB 链，普通用户请求不会触发任何全局巡检副作用。
export async function POST() {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const { processPending } = await import('@/lib/collect')
  const result = await processPending()
  return NextResponse.json(result)
}
