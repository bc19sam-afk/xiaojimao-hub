import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'

export async function GET() {
  const user = await getCurrentUser()
  const list = db.leaderboard(20)
  const me = user ? { linuxdoId: user.id, ...db.myRank(user.id) } : null
  return NextResponse.json({ list, me })
}
