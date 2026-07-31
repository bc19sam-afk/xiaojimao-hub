import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'

// 审计查看（P4-R1，§7.3）：倒序分页读 audit_log（最新在前）。只读——old/new 本就是 lib/audit.ts 构造的
// 脱敏摘要（绝不含 CDK 码/密钥，§8），故查看侧也不泄敏感值。query: ?limit=&offset=（db.listAudit 内钳
// limit∈[1,200]、offset≥0，脏输入安全）。
export async function GET(req: NextRequest) {
  if (!(await getAdminActor())) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', error: '无权限' }, { status: 403 })
  }
  const sp = new URL(req.url).searchParams
  const limit = Number(sp.get('limit') ?? 50)
  const offset = Number(sp.get('offset') ?? 0)
  try {
    return NextResponse.json({ ok: true, audit: db.listAudit(limit, offset) })
  } catch (error) {
    console.error('[admin] audit load failed', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json({
      ok: false,
      code: 'AUDIT_LOAD_FAILED',
      error: '审计记录暂时无法加载，请重试',
    }, { status: 500 })
  }
}
