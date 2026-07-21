import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { exchangeCodeForToken, fetchLinuxDoUser } from '@/lib/linuxdo'
import { signSession, SESSION_COOKIE, sessionCookieOptions, type SessionUser } from '@/lib/session'
import { originOf, isSecureRequest } from '@/lib/request'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const saved = req.cookies.get('ld_state')?.value
  const fail = (e: string) => NextResponse.redirect(new URL(`/login?error=${e}`, originOf(req)))

  if (!code || !state || !saved || state !== saved) return fail('state')

  try {
    const token = await exchangeCodeForToken(code)
    const profile = await fetchLinuxDoUser(token.access_token)
    const trustLevel = Number(profile.trust_level ?? 0)
    // 信任门槛后台可配（§1）：开关开且等级不足才拦；开关关＝登录即可、不限信任等级。缺省门槛回落 env。
    if (db.isTrustGateEnabled() && trustLevel < db.getMinTrustLevel()) return fail('trust')

    const user: SessionUser = {
      id: Number(profile.id),
      username: String(profile.username),
      name: profile.name ? String(profile.name) : undefined,
      trustLevel,
      avatar: profile.avatar_url ? String(profile.avatar_url) : undefined,
    }
    const jwt = await signSession(user)
    const res = NextResponse.redirect(new URL('/dashboard', originOf(req)))
    res.cookies.set(SESSION_COOKIE, jwt, sessionCookieOptions(isSecureRequest(req)))
    res.cookies.delete('ld_state')
    return res
  } catch (e) {
    console.error('[linuxdo callback]', e)
    return fail('oauth')
  }
}
