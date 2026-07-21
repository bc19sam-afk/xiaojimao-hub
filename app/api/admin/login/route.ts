import { NextRequest, NextResponse } from 'next/server'
import { checkAdminPassword, signAdminSession, adminCookie } from '@/lib/admin'
import { checkLocked, recordFail, recordSuccess } from '@/lib/admin-ratelimit'
import { isSecureRequest } from '@/lib/request'

export async function POST(req: NextRequest) {
  const now = Date.now()
  // 限流键取客户端 IP（x-forwarded-for 首个）；单机场景主要挡直连暴力猜密码（§8）。
  const key = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'direct'
  // 锁定期内直接拒绝——不泄剩余次数/锁定时长
  if (checkLocked(key, now)) {
    return NextResponse.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 })
  }
  const body = await req.json().catch(() => ({}))
  const pw = String(body.password || '')
  if (!checkAdminPassword(pw)) {
    recordFail(key, now) // 只记失败计数，绝不记密码原文（§8）
    return NextResponse.json({ error: '管理密码错误' }, { status: 401 })
  }
  recordSuccess(key) // 成功 → 清零该 IP 失败计数
  const jwt = await signAdminSession()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(adminCookie.name, jwt, adminCookie.options(isSecureRequest(req)))
  return res
}
