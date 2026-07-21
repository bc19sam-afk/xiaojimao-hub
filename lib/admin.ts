import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { env } from './env'
import { getCurrentUser } from './session'
import { resolveAdminActor, type Actor } from './admin-actor'

// ============================================================================
// 管理后台鉴权：两种入口任一满足即为管理员
//   ① 管理密码登录（ADMIN_PASSWORD）→ 独立 admin 会话 cookie
//   ② 当前 Linux.do 用户 id ∈ ADMIN_LINUXDO_IDS
//
// P4-R1 身份透传（§7.3 审计需记「操作人」）：鉴权从只返 boolean 升级为返 Actor——密码会话是匿名 JWT
// （payload {admin:true}）＝审计只能记通用标识「管理员(密码会话)」；linux.do 管理员有真实 id/用户名＝记真实身份。
// 纯决策 resolveAdminActor 抽到 lib/admin-actor.ts（不 import next/headers，可直测）；此处只做 Next 运行时读取。
// isAdmin 保留（内部判 actor 非空），现有 route 不破。
// ============================================================================

export type { Actor } // 对外仍从 '@/lib/admin' 取 Actor 类型（实际定义在 admin-actor）

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

// 当前请求的审计 Actor（无＝非管理员）。把 Next 运行时相关的读取（cookie / session）收在此处，
// 决策交给纯函数 resolveAdminActor（lib/admin-actor.ts）。
export async function getAdminActor(): Promise<Actor | null> {
  const passwordSession = Boolean(env.admin.password) && (await hasAdminCookie())
  const user = env.admin.linuxdoIds.length > 0 ? await getCurrentUser() : null
  return resolveAdminActor(passwordSession, user)
}

// 是否管理员（密码会话 或 Linux.do 管理员）——现基于 getAdminActor（actor 非空即管理员），语义不变
export async function isAdmin(): Promise<boolean> {
  return (await getAdminActor()) !== null
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
