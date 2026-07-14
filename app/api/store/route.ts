import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'

// 用户端商店：积分余额 + 可兑换项 + 我的兑换记录
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  return NextResponse.json({
    balance: db.balance(user.id),
    items: db.listRedeemItems(true),
    redemptions: db.listRedemptions(user.id),
  })
}
