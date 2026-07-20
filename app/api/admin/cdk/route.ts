import { NextRequest, NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin'
import { db } from '@/lib/db'
import { parseCdkCodes } from '@/lib/redeem'

// CDK 批量导入（P3-R1，§5.3）：后台预导入码到某兑换项。完整导入 UI 留 P4，本轮为最小 API。
//   body: { itemId, codes: string | string[] }  —— codes 支持「一行一码 / 逗号 / 空白分隔」文本或数组。
//   去重：parseCdkCodes 批内去重 + db.importCdkCodes 按 (item_id, code) 唯一键跨批去重。
//   ⚠️ 安全（§8）：绝不把 code 写进响应/日志；只回 { imported, skipped, available } 计数。
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  const itemId = Number(b.itemId)
  if (!itemId) return NextResponse.json({ error: '缺 itemId' }, { status: 400 })
  const item = db.getRedeemItem(itemId)
  if (!item) return NextResponse.json({ error: '兑换项不存在' }, { status: 404 })

  const codes = parseCdkCodes(b.codes ?? [])
  if (codes.length === 0) return NextResponse.json({ error: '无有效码' }, { status: 400 })

  const { imported, skipped } = db.importCdkCodes(itemId, codes)
  return NextResponse.json({ ok: true, imported, skipped, available: db.availableCdkCount(itemId) })
}

// 某项库存概览（导入后回看，不返回任何 code 值）
export async function GET(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const itemId = Number(new URL(req.url).searchParams.get('itemId'))
  if (!itemId) return NextResponse.json({ error: '缺 itemId' }, { status: 400 })
  return NextResponse.json({ ok: true, stats: db.cdkStatsFor(itemId) })
}
