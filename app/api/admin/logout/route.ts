import { NextRequest, NextResponse } from 'next/server'
import { adminCookie } from '@/lib/admin'
import { originOf } from '@/lib/request'

export async function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL('/admin', originOf(req)))
  res.cookies.delete(adminCookie.name)
  return res
}
