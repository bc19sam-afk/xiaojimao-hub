import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { redeem } from '@/lib/redeem'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const itemId = Number(body.itemId)
  if (!itemId) return NextResponse.json({ error: '缺 itemId' }, { status: 400 })
  // 幂等 token（客户端每次兑换手势生成、超时重试复用）：挡重复点击/超时重试重复扣分。缺失时服务端短窗兜底。
  const token = typeof body.token === 'string' ? body.token : undefined
  const res = redeem(user.id, itemId, { token })
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 })
  return NextResponse.json(res)
}
