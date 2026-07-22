import { NextRequest, NextResponse } from 'next/server'
import { checkAdminPassword, signAdminSession, adminCookie } from '@/lib/admin'
import { checkLocked, recordFail, recordSuccess, resolveClientKey } from '@/lib/admin-ratelimit'
import { isSecureRequest } from '@/lib/request'
import { trustForwardedHeaders } from '@/lib/env'

export async function POST(req: NextRequest) {
  const now = Date.now()
  // 限流键：转发头默认不可信 → 全部直连共享全局桶 'direct'，防伪造头轮换绕过；
  // 仅可信反代下才按其追加在末尾的真实 IP 分桶（详见 resolveClientKey）。单机场景挡暴力猜密码（§8）。
  const key = resolveClientKey(req.headers.get('x-forwarded-for'), trustForwardedHeaders)
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
