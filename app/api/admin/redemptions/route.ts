import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'

// 兑换记录全局查看（P4-R3，§6.146）：倒序分页只读。纯只读、不 recordAudit。
// 🔴 §8：db.listRedemptionsAdmin 绝不返回 result（CDK 码原文），此接口只回状态/商品/花费/时间/归属人。
// query ?limit=&offset=（db.listRedemptionsAdmin 内钳，脏输入安全）。
export async function GET(req: NextRequest) {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const sp = new URL(req.url).searchParams
  const limit = Number(sp.get('limit') ?? 50)
  const offset = Number(sp.get('offset') ?? 0)
  return NextResponse.json({ ok: true, redemptions: db.listRedemptionsAdmin(limit, offset) })
}
