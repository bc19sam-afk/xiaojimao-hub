import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditLdcQuota } from '@/lib/audit'

// LDC 每日额度读/改（P3-R2 §3，最小 admin API；后台 UI 于 P4-R1 补齐）。额度＝当日已发 LDC 面额之和上限
// （app_config['ldc_daily_quota']，缺省 2000）。取值钳非负整数由 db.setLdcQuota 兜底，此处再挡一道脏输入。
export async function GET() {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({ ok: true, quota: db.getLdcQuota() })
}

export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  // 只认 number 类型的非负安全整数（codex 于 PR #20 复审 P2）：Number() 宽转会把 true/''/[2000] 静默变成
  // 1/0/2000、小数被截断——脏请求可能把当日额度意外改小甚至关停（quota=0＝停发），故直接 400 拒绝。
  const n = b.quota
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    return NextResponse.json({ error: 'quota 须为非负整数' }, { status: 400 })
  const oldQuota = db.getLdcQuota()
  db.setLdcQuota(n)
  const newQuota = db.getLdcQuota()
  db.recordAudit(actor, auditLdcQuota(oldQuota, newQuota))
  return NextResponse.json({ ok: true, quota: newQuota })
}
