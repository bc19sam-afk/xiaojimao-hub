import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { finishOAuth } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

// redirect 流程：提交授权后地址栏的回调链接
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const provider = String(body.provider || 'codex') as ProviderId
  const url = String(body.redirect_url || '').trim()
  if (!VALID.includes(provider)) return NextResponse.json({ error: '不支持的类型' }, { status: 400 })
  if (!url) return NextResponse.json({ error: '请粘贴授权后地址栏的回调链接' }, { status: 400 })
  try {
    const res = await finishOAuth(user, provider, url)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 })
    return NextResponse.json({ message: '授权成功！账号已进入验证队列，通过后自动发放积分。' })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || '提交失败' }, { status: 502 })
  }
}
