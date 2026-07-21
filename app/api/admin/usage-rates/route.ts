import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditUsageRateUpsert, auditUsageRateDelete } from '@/lib/audit'

// 折算规则（按次单价）读/改/删（P4-R2 §3.4）：仿 point-rules，唯一差异＝单价可小数（points_per_call REAL）。
// GET 供 AdminPanel 初始加载（point-rules 走 /api/admin/config；usage-rates 自包含）。
export async function GET() {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({ ok: true, usageRates: db.listUsageRates() })
}

// 新增/更新折算规则
export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  if (!b.provider || !b.plan) return NextResponse.json({ error: '缺 provider/plan' }, { status: 400 })
  // ⚠️ 单价＝小数（points_per_call REAL）：只认 number 的有限非负值。绝不用 Number.isSafeInteger（否则 0.1
  // 单价被误拒），也不 Number() 宽转（把 true/''/[1] 静默变 1/0/1）——脏输入直接 400。
  const ppc = b.pointsPerCall
  if (typeof ppc !== 'number' || !Number.isFinite(ppc) || ppc < 0)
    return NextResponse.json({ error: 'pointsPerCall 须为非负数' }, { status: 400 })
  // 单价上界（P4-R2 codex 复审 P2）：1e6 × 现实日调用量 1e7 = 1e13 < 2^53，乘积必落安全整数区，杜绝结算侧
  // Math.round(次数 × 单价) 溢出 Infinity 落非法余额。超界 400（结算侧另有防御闸兜库里既有脏值）。
  if (ppc > 1_000_000)
    return NextResponse.json({ error: 'pointsPerCall 过大' }, { status: 400 })
  // provider/plan 规整小写＝与唯一键 / ratePerCall 查表口径一致：既用于查旧值定位，也用于审计 target（同一口径）
  const provider = String(b.provider).toLowerCase()
  const plan = String(b.plan).toLowerCase()
  const next = { provider, plan, pointsPerCall: ppc, enabled: b.enabled !== false, label: String(b.label || '') }
  const old = db.listUsageRates().find((r) => r.provider === provider && r.plan === plan)
  db.upsertUsageRate(next)
  db.recordAudit(actor, auditUsageRateUpsert(old, next))
  return NextResponse.json({ ok: true, usageRates: db.listUsageRates() })
}

// 删除折算规则
export async function DELETE(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!id) return NextResponse.json({ error: '缺 id' }, { status: 400 })
  const old = db.listUsageRates().find((r) => r.id === id)
  db.deleteUsageRate(id)
  db.recordAudit(actor, auditUsageRateDelete(old, id))
  return NextResponse.json({ ok: true, usageRates: db.listUsageRates() })
}
