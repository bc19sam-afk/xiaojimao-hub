import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { checkOAuth } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

// device 流程（Grok）：前端轮询此接口，直到 done。ok 则落号
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const provider = String(body.provider || 'grok') as ProviderId
  const state = String(body.state || '').trim()
  if (!VALID.includes(provider) || !state) return NextResponse.json({ error: '参数错误' }, { status: 400 })
  try {
    const r = await checkOAuth(user, provider, state)
    if (!r.done) return NextResponse.json({ done: false, error: r.error })
    if (!r.result.ok) return NextResponse.json({ done: true, error: r.result.error }, { status: 409 })
    return NextResponse.json({ done: true, message: '授权成功！账号已进入验证队列，通过后自动发放积分。' })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || '轮询失败' }, { status: 502 })
  }
}
