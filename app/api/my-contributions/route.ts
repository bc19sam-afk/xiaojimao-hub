import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { db, shortAccountLabel } from '@/lib/db'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  // 我的号：每号附累计积分（v4 积分不挂 contributions.points 列，靠 daily_settlements 汇总，§4/§6）。
  const contributions = db.byUser(user.id).map((c) => ({
    ...c,
    cumulativePoints: db.contributionPoints(c.id),
  }))
  // 最近退回记录（§3.2「告知用户登录失败/被封」）：账号掩码成 provider+短标识，不外发完整敏感号（§8）。
  const rejections = db.rejectionsFor(user.id).map((r) => ({
    id: r.id,
    account: shortAccountLabel(r.provider, r.accountId),
    reason: r.reason,
    createdAt: r.createdAt,
  }))
  return NextResponse.json({ contributions, rejections })
}
