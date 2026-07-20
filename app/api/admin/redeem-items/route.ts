import { NextRequest, NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin'
import { db } from '@/lib/db'

// 新增/更新兑换项
export async function PUT(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  if (!b.name || !b.kind) return NextResponse.json({ error: '缺 name/kind' }, { status: 400 })
  db.upsertRedeemItem({
    id: b.id ? Number(b.id) : undefined,
    name: String(b.name),
    description: String(b.description || ''),
    cost: Number(b.cost) || 0,
    kind: String(b.kind),
    enabled: b.enabled !== false,
    sort: Number(b.sort) || 0,
    config: typeof b.config === 'string' ? b.config : JSON.stringify(b.config ?? {}),
    // 履约类型（placeholder/cdk）+ 每人限购透传：未带则 upsert 里 COALESCE 保留原值 / 新建用默认。
    // 缺这俩透传＝导了 CDK 码也没入口把项激活成发码类（codex+bot 复审 P1：用户被扣分却只收占位、CDK 永不出库）。
    fulfillment: typeof b.fulfillment === 'string' ? b.fulfillment : undefined,
    perUserLimit: b.perUserLimit != null ? Number(b.perUserLimit) : undefined,
  })
  return NextResponse.json({ ok: true, redeemItems: db.listRedeemItems(false) })
}

// 删除兑换项
export async function DELETE(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!id) return NextResponse.json({ error: '缺 id' }, { status: 400 })
  db.deleteRedeemItem(id)
  return NextResponse.json({ ok: true, redeemItems: db.listRedeemItems(false) })
}
