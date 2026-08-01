import { NextRequest } from 'next/server'
import { recoverOAuthSession } from '@/lib/collect'
import type { ProviderId } from '@/lib/cpa'
import {
  oauthExceptionResponse,
  oauthFailureResponse,
  oauthSessionResponse,
} from '@/lib/oauth-route'
import { getCurrentUser } from '@/lib/session'

const VALID: ProviderId[] = ['codex', 'claude', 'grok']

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return oauthFailureResponse('AUTH_REQUIRED')
  const provider = String(req.nextUrl.searchParams.get('provider') || '') as ProviderId
  if (!VALID.includes(provider)) return oauthFailureResponse('UNSUPPORTED_PROVIDER')
  try {
    return oauthSessionResponse(recoverOAuthSession(user, provider))
  } catch (error) {
    return oauthExceptionResponse(error, 'CPA_UNAVAILABLE')
  }
}
