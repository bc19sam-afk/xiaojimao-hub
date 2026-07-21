import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'

// 贡献记录全局查看（P4-R3，§6.146）：倒序分页只读。脱敏——listContributionsAdmin 只 SELECT 展示列，
// 不含 email/reward_code（§8）。纯只读、不 recordAudit（看数据非可审计写操作）。
// query ?limit=&offset=（db.listContributionsAdmin 内钳 limit∈[1,200]、offset≥0，脏输入安全）。
export async function GET(req: NextRequest) {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const sp = new URL(req.url).searchParams
  const limit = Number(sp.get('limit') ?? 50)
  const offset = Number(sp.get('offset') ?? 0)
  return NextResponse.json({ ok: true, contributions: db.listContributionsAdmin(limit, offset) })
}
