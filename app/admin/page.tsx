import { isAdmin } from '@/lib/admin'
import { env } from '@/lib/env'
import AdminLogin from '@/components/admin/AdminLogin'
import AdminPanel from '@/components/admin/AdminPanel'

// 强制每请求动态渲染，禁止构建期静态预渲染。
// 为何必需：getAdminActor()（lib/admin.ts）在 ADMIN_PASSWORD/ADMIN_LINUXDO_IDS 都为空时，靠 `&&`
//   与三元短路——根本不触 cookies()/session。Next 遂判本页无动态 API，构建期把它预渲染成静态 HTML，
//   将 hasPassword={Boolean(env.admin.password)} 按当时空值烘死为 false。Docker 构建正是这种环境
//   （.dockerignore 拦掉 .env → 构建期 ADMIN_* 全空），运行期 compose 注入的 ADMIN_PASSWORD 永不
//   被重新求值 → 后台登录框消失、永久不可达。force-dynamic 消除该烘死。
export const dynamic = 'force-dynamic'

export const metadata = { title: '管理后台 · 小鸡毛' }

export default async function AdminPage() {
  const ok = await isAdmin()
  if (!ok) {
    return <AdminLogin hasPassword={Boolean(env.admin.password)} />
  }
  return <AdminPanel />
}
