import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { ingestRT } from '@/lib/collect'

// 直贴 Refresh Token：后端换 token → 上传入池 → 进验证队列。
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const rt = String(body.refresh_token || '').trim()
  if (!rt) return NextResponse.json({ error: '请填写 Refresh Token' }, { status: 400 })
  try {
    const res = await ingestRT(user, rt)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 })
    return NextResponse.json({ message: 'RT 提交成功！账号已进入验证队列。' })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || '提交失败' }, { status: 502 })
  }
}
