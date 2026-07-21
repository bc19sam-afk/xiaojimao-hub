import { NextRequest, NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin'
import { db } from '@/lib/db'

// LDC 每日额度读/改（P3-R2 §3，最小 admin API；完整后台 UI 留 P4）。额度＝当日已发 LDC 面额之和上限
// （app_config['ldc_daily_quota']，缺省 2000）。取值钳非负整数由 db.setLdcQuota 兜底，此处再挡一道脏输入。
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({ ok: true, quota: db.getLdcQuota() })
}

export async function PUT(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  const n = Number(b.quota)
  if (b.quota == null || !Number.isFinite(n) || n < 0)
    return NextResponse.json({ error: 'quota 须为非负数' }, { status: 400 })
  db.setLdcQuota(n)
  return NextResponse.json({ ok: true, quota: db.getLdcQuota() })
}
