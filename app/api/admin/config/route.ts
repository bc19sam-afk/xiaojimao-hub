import { NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin'
import { db } from '@/lib/db'

// 读取全部配置（发分规则 + 兑换项）
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({
    pointRules: db.listPointRules(),
    redeemItems: db.listRedeemItems(false),
    overview: db.adminOverview(),
  })
}
