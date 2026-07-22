import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditPoolPriority } from '@/lib/audit'

// 入池优先级读/改（对接-R2b，§2.5/§7.1）：贡献号入池即设的全局优先级（cpamp 数字越大越优先），
// app_config['pool_priority']，缺省 10、后台可调。取值钳非负整数由 db.setPoolPriority 兜底，此处再挡一道脏输入。
export async function GET() {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  return NextResponse.json({ ok: true, poolPriority: db.getPoolPriority() })
}

export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  // 只认 number 类型的非负安全整数（仿 ldc-quota）：Number() 宽转会把 true/''/[10] 静默变成 1/0/10、
  // 小数被截断——脏请求可能把优先级意外改乱，故直接 400 拒绝。
  const n = b.poolPriority
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    return NextResponse.json({ error: 'poolPriority 须为非负整数' }, { status: 400 })
  const oldN = db.getPoolPriority()
  db.setPoolPriority(n)
  const newN = db.getPoolPriority()
  db.recordAudit(actor, auditPoolPriority(oldN, newN))
  return NextResponse.json({ ok: true, poolPriority: newN })
}
