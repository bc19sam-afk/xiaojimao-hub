import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditSettleParam } from '@/lib/audit'

// 结算参数读/改（P4-R2 §3.3）：结算时刻＝午夜后延迟分钟数（日切延迟），缺省 10、钳 [0,1439]。
// 时区随服务器不可配（§3.3）。graceMinutes 存 app_config['settle_grace_minutes']。
export async function GET() {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({ ok: true, graceMinutes: db.getSettleGraceMs() / 60_000 })
}

export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  // graceMinutes 必为非负安全整数；上钳 1439 由 setSettleGraceMinutes 兜底。脏输入 400，不 Number() 宽转。
  const n = b.graceMinutes
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    return NextResponse.json({ error: 'graceMinutes 须为非负整数' }, { status: 400 })
  const oldMinutes = db.getSettleGraceMs() / 60_000
  db.setSettleGraceMinutes(n)
  const newMinutes = db.getSettleGraceMs() / 60_000
  db.recordAudit(actor, auditSettleParam(oldMinutes, newMinutes))
  return NextResponse.json({ ok: true, graceMinutes: newMinutes })
}
