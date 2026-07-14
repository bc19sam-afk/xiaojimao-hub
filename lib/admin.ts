import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { env } from './env'
import { getCurrentUser } from './session'

// ============================================================================
// 管理后台鉴权：两种入口任一满足即为管理员
//   ① 管理密码登录（ADMIN_PASSWORD）→ 独立 admin 会话 cookie
//   ② 当前 Linux.do 用户 id ∈ ADMIN_LINUXDO_IDS
// ============================================================================

const secret = new TextEncoder().encode(env.sessionSecret + ':admin')
const ADMIN_COOKIE = 'admin'

export async function signAdminSession(): Promise<string> {
  return new SignJWT({ admin: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

async function hasAdminCookie(): Promise<boolean> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value
  if (!token) return false
  try {
    await jwtVerify(token, secret)
    return true
  } catch {
    return false
  }
}

// 是否管理员（密码会话 或 Linux.do 管理员）
export async function isAdmin(): Promise<boolean> {
  if (env.admin.password && (await hasAdminCookie())) return true
  if (env.admin.linuxdoIds.length > 0) {
    const user = await getCurrentUser()
    if (user && env.admin.linuxdoIds.includes(user.id)) return true
  }
  return false
}

// 校验管理密码
export function checkAdminPassword(pw: string): boolean {
  return Boolean(env.admin.password) && pw === env.admin.password
}

export const adminCookie = {
  name: ADMIN_COOKIE,
  options: (secure: boolean) => ({
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  }),
}
