import { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { checkOAuth } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'
import {
  oauthCompletedResponse,
  oauthExceptionResponse,
  oauthFailureResponse,
  oauthPendingResponse,
  parseOAuthRequestBody,
} from '@/lib/oauth-route'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

// device 流程（Grok）：前端轮询此接口，直到 done。ok 则落号
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return oauthFailureResponse('AUTH_REQUIRED')
  const parsed = await parseOAuthRequestBody(req)
  if (!parsed.ok) return parsed.response
  const body = parsed.body
  const provider = String(body.provider || 'grok') as ProviderId
  const state = String(body.state || '').trim()
  if (!VALID.includes(provider)) return oauthFailureResponse('UNSUPPORTED_PROVIDER')
  if (!state) return oauthFailureResponse('INVALID_REQUEST')
  try {
    const r = await checkOAuth(user, provider, state)
    if (!r.done) return r.code ? oauthFailureResponse(r.code) : oauthPendingResponse()
    if (!r.result.ok) return oauthFailureResponse(r.result.code)
    return oauthCompletedResponse('授权成功！账号已进入验证队列，通过后自动发放积分。')
  } catch (e) {
    return oauthExceptionResponse(e, 'CPA_UNAVAILABLE')
  }
}
