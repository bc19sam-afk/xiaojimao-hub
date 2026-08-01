import { NextRequest } from 'next/server'
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

// Cookie 的 SameSite 边界是 site，不是 origin。同站 sibling 仍可携带会话 cookie 发起
// text/plain blind POST，因此高副作用 JSON 路由必须同时锁定精确 origin 与媒体类型。
export function isSameOriginJsonMutation(req: NextRequest): boolean {
  const contentType = req.headers.get('content-type')
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') return false

  const origin = req.headers.get('origin')
  if (!origin || origin === 'null') return false

  try {
    return origin === new URL(originOf(req)).origin
  } catch {
    return false
  }
}

// cookie 是否走 secure：跟随推断出的 origin 协议
export function isSecureRequest(req: NextRequest): boolean {
  return originOf(req).startsWith('https://')
}
