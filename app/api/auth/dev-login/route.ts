import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { signSession, SESSION_COOKIE, sessionCookieOptions, type SessionUser } from '@/lib/session'
import { originOf, isSecureRequest } from '@/lib/request'

// 仅模拟模式可用的预览登录：跳过 Linux.do OAuth，直接建会话进 dashboard。
// 填了真实 Linux.do 配置（MOCK=false）后此路由返回 404，不会流入生产。
export async function GET(req: NextRequest) {
  if (!env.mock) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const user: SessionUser = {
    id: 1,
    username: 'preview',
    name: '预览用户',
    trustLevel: 3,
  }
  const jwt = await signSession(user)
  const res = NextResponse.redirect(new URL('/dashboard', originOf(req)))
  res.cookies.set(SESSION_COOKIE, jwt, sessionCookieOptions(isSecureRequest(req)))
  return res
}
