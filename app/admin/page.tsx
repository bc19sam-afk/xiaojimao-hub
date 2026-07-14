import { isAdmin } from '@/lib/admin'
import { env } from '@/lib/env'
import AdminLogin from '@/components/admin/AdminLogin'
import AdminPanel from '@/components/admin/AdminPanel'

export const metadata = { title: '管理后台 · 小鸡毛' }

export default async function AdminPage() {
  const ok = await isAdmin()
  if (!ok) {
    return <AdminLogin hasPassword={Boolean(env.admin.password)} />
  }
  return <AdminPanel />
}
