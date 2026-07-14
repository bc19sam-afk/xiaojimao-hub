import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { env } from '@/lib/env'
import { buildAuthorizeUrl } from '@/lib/linuxdo'
import { originOf, isSecureRequest } from '@/lib/request'

export async function GET(req: NextRequest) {
  if (!env.linuxdo.clientId) {
    return NextResponse.redirect(new URL('/login?error=config', originOf(req)))
  }
  const state = randomBytes(16).toString('hex')
  const res = NextResponse.redirect(buildAuthorizeUrl(state))
  res.cookies.set('ld_state', state, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  })
  return res
}
