import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditTrustGate } from '@/lib/audit'

// 信任等级门槛 & 限身份开关读/改（P4-R2 §1）。两控件：enabled 是否启用门槛（关＝登录即可、不限等级）+
// minTrust 门槛数值。门槛只在登录回调判，调整不影响已登录会话（保留至过期）。
export async function GET() {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({ ok: true, enabled: db.isTrustGateEnabled(), minTrust: db.getMinTrustLevel() })
}

export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  // enabled 必为 boolean；minTrust 必为非负安全整数（门槛＝整数等级）。脏输入 400，不 Number() 宽转。
  if (typeof b.enabled !== 'boolean')
    return NextResponse.json({ error: 'enabled 须为布尔' }, { status: 400 })
  if (typeof b.minTrust !== 'number' || !Number.isSafeInteger(b.minTrust) || b.minTrust < 0)
    return NextResponse.json({ error: 'minTrust 须为非负整数' }, { status: 400 })
  const old = { enabled: db.isTrustGateEnabled(), minTrust: db.getMinTrustLevel() }
  db.setTrustGateEnabled(b.enabled)
  db.setMinTrustLevel(b.minTrust)
  const next = { enabled: db.isTrustGateEnabled(), minTrust: db.getMinTrustLevel() }
  db.recordAudit(actor, auditTrustGate(old, next))
  return NextResponse.json({ ok: true, ...next })
}
