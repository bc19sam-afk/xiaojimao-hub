import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditContributionReview } from '@/lib/audit'

// 人工复核处理（P4-R3，§7.4）：needs_review 号（残缺号 / 首检 reauth）的人工重试/终止——补上死胡同出口。
// 🔴 §7.4 幂等：retryReview/terminateReview 都只走 transition CAS 改 verify_status，完全不碰
//   daily_settlements / point_ledger，故「不得绕过同号同日只结算一次」天然成立（重试不结算、终止不删账本）。

// needs_review 队列投影（只挑展示字段，GET 与 POST 后刷新共用）
function reviewQueue() {
  return db.byVerifyStatus(['needs_review']).map((c) => ({
    id: c.id,
    linuxdoId: c.linuxdoId,
    username: c.username,
    provider: c.provider,
    accountId: c.accountId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }))
}

// 列队列
export async function GET() {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({ ok: true, review: reviewQueue() })
}

// 处理：body { id, action:'retry'|'terminate' }。转成功才 recordAudit（CAS 返 false＝态已变，不审计）。
export async function POST(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  const action = b.action
  // action 只认这两值，否则 400（不宽转）
  if (action !== 'retry' && action !== 'terminate')
    return NextResponse.json({ error: 'action 须为 retry|terminate' }, { status: 400 })
  const id = typeof b.id === 'string' ? b.id : ''
  if (!id) return NextResponse.json({ error: '缺 id' }, { status: 400 })
  const c = db.all().find((x) => x.id === id)
  if (!c) return NextResponse.json({ error: '记录不存在' }, { status: 400 })
  // CAS 转态：仅当仍处 needs_review 才转；返 false＝态已变（并发/已处理）→ 不审计、不改
  const ok = action === 'retry' ? db.retryReview(id) : db.terminateReview(id)
  if (!ok) return NextResponse.json({ ok: false, error: '状态已变' })
  db.recordAudit(
    actor,
    auditContributionReview(action === 'retry' ? 'contribution.retry' : 'contribution.terminate', c),
  )
  return NextResponse.json({ ok: true, review: reviewQueue() })
}
