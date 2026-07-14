import { NextRequest, NextResponse } from 'next/server'
import { env, trustForwardedHeaders } from './env'

// 推断当前请求的 origin，用于重定向 / cookie secure 判断。
//
// 安全：x-forwarded-* 头可被伪造。默认（生产）固定用 APP_BASE_URL，避免开放重定向；
// 仅当 TRUST_FORWARDED_HEADERS=true（mock/dev，或反代已清洗覆盖这些头）时才采信转发头，
// 以便本地隧道 / 反代下重定向回到实际访问域名。
export function originOf(req: NextRequest): string {
  if (trustForwardedHeaders) {
    const h = req.headers
    const proto = h.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '')
    const host = h.get('x-forwarded-host') ?? h.get('host') ?? new URL(req.url).host
    return `${proto}://${host}`
  }
  return env.appBaseUrl.replace(/\/+$/, '')
}

// 重定向到当前 origin 下的某路径
export function redirectTo(req: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, originOf(req)))
}

// cookie 是否走 secure：跟随推断出的 origin 协议
export function isSecureRequest(req: NextRequest): boolean {
  return originOf(req).startsWith('https://')
}
