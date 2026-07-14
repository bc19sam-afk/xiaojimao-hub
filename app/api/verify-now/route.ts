import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { processPending } from '@/lib/collect'

// 手动触发验证（演示用）。P2 会做成后台定时 worker。
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const result = await processPending()
  return NextResponse.json(result)
}
