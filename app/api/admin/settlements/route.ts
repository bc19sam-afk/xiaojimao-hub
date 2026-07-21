import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'

// 每日用量结算记录全局查看（P4-R3，§6.146）：倒序分页只读（id DESC）。LEFT JOIN 取归属人 username/linuxdoId。
// 纯只读、不 recordAudit。query ?limit=&offset=（db.listSettlementsAdmin 内钳，脏输入安全）。
export async function GET(req: NextRequest) {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const sp = new URL(req.url).searchParams
  const limit = Number(sp.get('limit') ?? 50)
  const offset = Number(sp.get('offset') ?? 0)
  return NextResponse.json({ ok: true, settlements: db.listSettlementsAdmin(limit, offset) })
}
