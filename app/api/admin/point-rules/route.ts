import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { parsePositiveSafeInteger } from '@/lib/admin-input'
import { db } from '@/lib/db'
import { auditPointRuleUpsert, auditPointRuleDelete } from '@/lib/audit'

const POINT_RULE_INVALID_ID = {
  ok: false,
  code: 'POINT_RULE_INVALID_ID',
  error: '发分规则 ID 无效',
} as const

const POINT_RULE_NOT_FOUND = {
  ok: false,
  code: 'POINT_RULE_NOT_FOUND',
  error: '发分规则不存在或已被删除',
} as const

const POINT_RULE_DELETE_FAILURE = {
  ok: false,
  code: 'POINT_RULE_DELETE_FAILED',
  error: '删除发分规则失败，请重试',
} as const

class PointRuleNotFoundError extends Error {}

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
  const id = parsePositiveSafeInteger(new URL(req.url).searchParams.get('id'))
  if (id === null) return NextResponse.json(POINT_RULE_INVALID_ID, { status: 400 })
  try {
    const pointRules = db.withTransaction(() => {
      const old = db.listPointRules().find((r) => r.id === id)
      if (!old || !db.deletePointRule(id)) throw new PointRuleNotFoundError()
      db.recordAudit(actor, auditPointRuleDelete(old, id))
      return db.listPointRules()
    })
    return NextResponse.json({ ok: true, pointRules })
  } catch (error) {
    if (error instanceof PointRuleNotFoundError) {
      return NextResponse.json(POINT_RULE_NOT_FOUND, { status: 404 })
    }
    console.error('[admin] point rule delete failed', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json(POINT_RULE_DELETE_FAILURE, { status: 500 })
  }
}
