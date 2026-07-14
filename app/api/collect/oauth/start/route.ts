import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { startOAuth } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

// 发起授权：按 provider 返回 {state, url, flow, userCode}
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const provider = String(body.provider || 'codex') as ProviderId
  if (!VALID.includes(provider)) return NextResponse.json({ error: '不支持的类型' }, { status: 400 })
  try {
    return NextResponse.json(await startOAuth(provider))
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || '发起授权失败' }, { status: 502 })
  }
}
