import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/session'
import DashboardShell from '@/components/DashboardShell'

export default async function Dashboard() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return (
    <DashboardShell
      user={{ id: user.id, username: user.username, name: user.name, trustLevel: user.trustLevel }}
    />
  )
}
