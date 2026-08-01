import { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { finishOAuth } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'
import {
  oauthCompletedResponse,
  oauthExceptionResponse,
  oauthFailureResponse,
} from '@/lib/oauth-route'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

// redirect 流程：提交授权后地址栏的回调链接
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return oauthFailureResponse('AUTH_REQUIRED')
  const body = await req.json().catch(() => ({}))
  const provider = String(body.provider || 'codex') as ProviderId
  const url = String(body.redirect_url || '').trim()
  if (!VALID.includes(provider)) return oauthFailureResponse('UNSUPPORTED_PROVIDER')
  if (!url) return oauthFailureResponse('INVALID_REQUEST')
  try {
    if (!new URL(url).searchParams.get('state')) return oauthFailureResponse('INVALID_REQUEST')
  } catch {
    return oauthFailureResponse('INVALID_REQUEST')
  }
  try {
    const res = await finishOAuth(user, provider, url)
    if (!res.ok) return oauthFailureResponse(res.code)
    return oauthCompletedResponse('授权成功！账号已进入验证队列，通过后自动发放积分。')
  } catch (e) {
    return oauthExceptionResponse(e, 'CPA_UNAVAILABLE')
  }
}
