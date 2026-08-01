import { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { startOAuth } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'
import {
  oauthExceptionResponse,
  oauthFailureResponse,
  oauthSessionResponse,
  parseOAuthRequestBody,
} from '@/lib/oauth-route'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

// 发起授权：按 provider 返回 {state, url, flow, userCode}
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return oauthFailureResponse('AUTH_REQUIRED')
  const parsed = await parseOAuthRequestBody(req)
  if (!parsed.ok) return parsed.response
  const body = parsed.body
  const provider = String(body.provider || 'codex') as ProviderId
  if (!VALID.includes(provider)) return oauthFailureResponse('UNSUPPORTED_PROVIDER')
  try {
    return oauthSessionResponse(await startOAuth(user, provider))
  } catch (e) {
    return oauthExceptionResponse(e, 'CPA_UNAVAILABLE')
  }
}
