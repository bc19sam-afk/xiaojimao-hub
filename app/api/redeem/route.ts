import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { redeem } from '@/lib/redeem'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const itemId = Number(body.itemId)
  if (!itemId) return NextResponse.json({ error: '缺 itemId' }, { status: 400 })
  const res = redeem(user.id, itemId)
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 })
  return NextResponse.json(res)
}
