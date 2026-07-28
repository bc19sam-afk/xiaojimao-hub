import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditPointRuleUpsert, auditPointRuleDelete } from '@/lib/audit'

const POINT_RULE_DELETE_FAILURE = {
  ok: false,
  code: 'POINT_RULE_DELETE_FAILED',
  error: '删除发分规则失败，请重试',
} as const

// 新增/更新发分规则
export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  if (!b.provider || !b.plan) return NextResponse.json({ error: '缺 provider/plan' }, { status: 400 })
  // provider/plan 规整小写＝与唯一键/落库一致：既用于查旧值定位，也用于审计 target（同一口径）
  const provider = String(b.provider).toLowerCase()
  const plan = String(b.plan).toLowerCase()
  const next = { provider, plan, points: Number(b.points) || 0, enabled: b.enabled !== false, label: String(b.label || '') }
  const old = db.listPointRules().find((r) => r.provider === provider && r.plan === plan)
  db.upsertPointRule(next)
  db.recordAudit(actor, auditPointRuleUpsert(old, next))
  return NextResponse.json({ ok: true, pointRules: db.listPointRules() })
}

// 删除发分规则
export async function DELETE(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!id) return NextResponse.json({ error: '缺 id' }, { status: 400 })
  try {
    const old = db.listPointRules().find((r) => r.id === id)
    db.deletePointRule(id)
    db.recordAudit(actor, auditPointRuleDelete(old, id))
    return NextResponse.json({ ok: true, pointRules: db.listPointRules() })
  } catch {
    return NextResponse.json(POINT_RULE_DELETE_FAILURE, { status: 500 })
  }
}
