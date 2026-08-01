import { NextRequest } from 'next/server'
import { cancelOAuth } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'
import {
  oauthCancelledResponse,
  oauthExceptionResponse,
  oauthFailureResponse,
} from '@/lib/oauth-route'
import { getCurrentUser } from '@/lib/session'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return oauthFailureResponse('AUTH_REQUIRED')
  const body = await req.json().catch(() => ({}))
  const provider = String(body.provider || '') as ProviderId
  const state = String(body.state || '').trim()
  if (!VALID.includes(provider)) return oauthFailureResponse('UNSUPPORTED_PROVIDER')
  if (!state) return oauthFailureResponse('INVALID_REQUEST')
  try {
    const result = await cancelOAuth(user, provider, state)
    if (result.status === 'invalid') return oauthFailureResponse('OAUTH_SESSION_INVALID')
    if (result.status === 'conflict') return oauthFailureResponse('TRANSITION_CONFLICT')
    return oauthCancelledResponse()
  } catch (error) {
    return oauthExceptionResponse(error, 'CPA_UNAVAILABLE')
  }
}
