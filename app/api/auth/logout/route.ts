import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session'
import { originOf } from '@/lib/request'

export async function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL('/login', originOf(req)))
  res.cookies.delete(SESSION_COOKIE)
  return res
}
