import { NextRequest, NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin'
import { db } from '@/lib/db'

// 新增/更新发分规则
export async function PUT(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  if (!b.provider || !b.plan) return NextResponse.json({ error: '缺 provider/plan' }, { status: 400 })
  db.upsertPointRule({
    provider: String(b.provider),
    plan: String(b.plan),
    points: Number(b.points) || 0,
    enabled: b.enabled !== false,
    label: String(b.label || ''),
  })
  return NextResponse.json({ ok: true, pointRules: db.listPointRules() })
}

// 删除发分规则
export async function DELETE(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!id) return NextResponse.json({ error: '缺 id' }, { status: 400 })
  db.deletePointRule(id)
  return NextResponse.json({ ok: true, pointRules: db.listPointRules() })
}
