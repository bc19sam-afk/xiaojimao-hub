import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { ingestRT } from '@/lib/collect'
import { CPA_UNAVAILABLE, INVALID_REFRESH_TOKEN_ERROR } from '@/lib/cpa'
import { oauthFailure, type OAuthErrorCode } from '@/lib/oauth-protocol'
import { isSameOriginJsonMutation } from '@/lib/request'

const INVALID_REQUEST_ERROR = '请求无效'
const UNKNOWN_SUBMISSION_ERROR = '提交失败'

type RTBodyResult = { ok: true; rt: string } | { ok: false }

async function parseRTRequestBody(request: Pick<Request, 'json'>): Promise<RTBodyResult> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { ok: false }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const refreshToken = (body as Record<string, unknown>).refresh_token
  if (typeof refreshToken !== 'string') return { ok: false }
  const rt = refreshToken.trim()
  return rt ? { ok: true, rt } : { ok: false }
}

function rtProtocolFailure(code: OAuthErrorCode): NextResponse {
  const failure = oauthFailure(code)
  return NextResponse.json({ error: failure.body.error.message }, { status: failure.status })
}

// 直贴 Refresh Token：后端换 token → 上传入池 → 进验证队列。
export async function POST(req: NextRequest) {
  if (!isSameOriginJsonMutation(req)) {
    return NextResponse.json({ error: INVALID_REQUEST_ERROR }, { status: 400 })
  }
  const parsed = await parseRTRequestBody(req)
  if (!parsed.ok) return NextResponse.json({ error: INVALID_REQUEST_ERROR }, { status: 400 })
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const res = await ingestRT(user, parsed.rt)
    if (!res.ok) return rtProtocolFailure(res.code)
    return NextResponse.json({ message: 'RT 提交成功！账号已进入验证队列。' })
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_REFRESH_TOKEN_ERROR) {
      return NextResponse.json({ error: INVALID_REFRESH_TOKEN_ERROR }, { status: 502 })
    }
    if (error instanceof Error && error.message === CPA_UNAVAILABLE) {
      return rtProtocolFailure('CPA_UNAVAILABLE')
    }
    console.error('[collect-rt] ingest_failed')
    return NextResponse.json({ error: UNKNOWN_SUBMISSION_ERROR }, { status: 502 })
  }
}
