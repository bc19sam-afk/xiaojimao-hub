import { NextResponse } from 'next/server'
import {
  oauthErrorCode,
  oauthFailure,
  oauthPending,
  type OAuthErrorCode,
  type OAuthSessionView,
} from './oauth-protocol'

export type OAuthRequestBody = Record<string, unknown>

export type OAuthRequestBodyResult =
  | { ok: true; body: OAuthRequestBody }
  | { ok: false; response: NextResponse }

export async function parseOAuthRequestBody(
  request: Pick<Request, 'json'>,
): Promise<OAuthRequestBodyResult> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { ok: false, response: oauthFailureResponse('INVALID_REQUEST') }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, response: oauthFailureResponse('INVALID_REQUEST') }
  }
  return { ok: true, body: body as OAuthRequestBody }
}

export function oauthFailureResponse(code: OAuthErrorCode): NextResponse {
  const failure = oauthFailure(code)
  return NextResponse.json(failure.body, { status: failure.status })
}

export function oauthExceptionResponse(error: unknown, fallback: OAuthErrorCode): NextResponse {
  return oauthFailureResponse(oauthErrorCode(error, fallback))
}

export function oauthPendingResponse(): NextResponse {
  const pending = oauthPending()
  return NextResponse.json(pending.body, { status: pending.status })
}

export function oauthSessionResponse(session: OAuthSessionView | null): NextResponse {
  return NextResponse.json({ ok: true, session })
}

export function oauthCompletedResponse(message: string): NextResponse {
  return NextResponse.json({ ok: true, status: 'completed', message })
}

export function oauthCancelledResponse(): NextResponse {
  return NextResponse.json({ ok: true, status: 'cancelled' })
}
