import { env } from './env'
import type { SessionUser } from './session' // type-only：类型擦除，不在运行时 import session（避免拉进 next/headers）

// ============================================================================
// 审计操作人（Actor）解析 —— 纯决策，抽出到独立模块（不 import next/headers）便于直测两入口身份。
// admin.ts 负责 Next 运行时读取（cookie / session），把布尔/用户交给此处映射。
//
// 产品已定（勿改标识文案，§7.3）：
//   password —— 管理密码会话，匿名通用标识（密码 JWT payload 只有 {admin:true}，无法记具体人）
//   linuxdo  —— linux.do 管理员，记真实 id + 用户名
// ============================================================================

export interface Actor {
  type: 'password' | 'linuxdo'
  id?: number // linux.do 数字 id；password 会话无
  label: string // 展示名：'管理员(密码会话)' / linux.do 用户名
}

export const PASSWORD_ACTOR_LABEL = '管理员(密码会话)'

// 纯映射：给定「密码会话是否有效」与「当前 linux.do 用户」，解析出审计 Actor 或 null。
// 优先级＝密码会话优先（与旧 isAdmin 短路顺序一致，不改变哪个入口「胜出」）。passwordSession 已含
// env.admin.password 存在性判定（见 admin.getAdminActor），此处只作映射；linux.do 分支在此判白名单
// （env.admin.linuxdoIds），故白名单成员判定亦被覆盖测试。
export function resolveAdminActor(passwordSession: boolean, user: SessionUser | null): Actor | null {
  if (passwordSession) return { type: 'password', label: PASSWORD_ACTOR_LABEL }
  if (user && env.admin.linuxdoIds.includes(user.id))
    return { type: 'linuxdo', id: user.id, label: user.username }
  return null
}
