import { NextRequest, NextResponse } from 'next/server'
import { checkAdminPassword, signAdminSession, adminCookie } from '@/lib/admin'
import { isSecureRequest, originOf } from '@/lib/request'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const pw = String(body.password || '')
  if (!checkAdminPassword(pw)) {
    return NextResponse.json({ error: '管理密码错误' }, { status: 401 })
  }
  const jwt = await signAdminSession()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(adminCookie.name, jwt, adminCookie.options(isSecureRequest(req)))
  void originOf
  return res
}
