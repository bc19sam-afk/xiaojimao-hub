import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { parseCdkCodes } from '@/lib/redeem'
import { auditCdkImport } from '@/lib/audit'

// CDK 批量导入（P3-R1，§5.3；P3-R2 加批级面额）：后台预导入码到某兑换项。完整导入 UI 留 P4，本轮为最小 API。
//   body: { itemId, codes: string | string[], faceValue? }  —— codes 支持「一行一码 / 逗号 / 空白分隔」文本或数组。
//   去重：parseCdkCodes 批内去重 + db.importCdkCodes 按 (item_id, code) 唯一键跨批去重。
//   面额策略（P3-R2 §1）：LDC 商品（kind='ldc'）导入**必须带正整数面额 faceValue**（一批同面额，不同面额分批导），
//     缺失/非正整数一律 400 拒绝——否则码无面额会绕过每日额度约束（ldcIssuedToday 只统计带面额的码）；
//     非 LDC 商品的面额一律忽略、恒落 null（不受额度约束，保持 R1 行为）。
//   ⚠️ 安全（§8）：绝不把 code / 面额值写进响应之外的日志；只回 { imported, skipped, available } 计数。
export async function POST(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  const itemId = Number(b.itemId)
  if (!itemId) return NextResponse.json({ error: '缺 itemId' }, { status: 400 })
  const item = db.getRedeemItem(itemId)
  if (!item) return NextResponse.json({ error: '兑换项不存在' }, { status: 404 })

  const codes = parseCdkCodes(b.codes ?? [])
  if (codes.length === 0) return NextResponse.json({ error: '无有效码' }, { status: 400 })

  // LDC 商品必带正整数面额；非 LDC 恒 null（忽略任何传入面额）。严格校验（codex 于 PR #20 复审 P2）：
  // 只认 number 类型的正整数——Number() 宽转会把 true/[100]/'100' 都变成数、小数被 floor 静默截断，
  // 超过 MAX_SAFE_INTEGER 的值落库后 node:sqlite 读取还会抛 ERR_OUT_OF_RANGE 把商店接口打成持续 500。
  let faceValue: number | null = null
  if (item.kind === 'ldc') {
    const fv = b.faceValue
    if (typeof fv !== 'number' || !Number.isSafeInteger(fv) || fv <= 0)
      return NextResponse.json({ error: 'LDC 商品导入须提供正整数面额 faceValue' }, { status: 400 })
    faceValue = fv
  }

  const availableBefore = db.availableCdkCount(itemId)
  const { imported, skipped } = db.importCdkCodes(itemId, codes, faceValue)
  const availableAfter = db.availableCdkCount(itemId)
  // 审计（§8 脱敏铁律）：只记「导入 N / 跳过 M（面额 F）+ 库存 before→after」计数摘要——auditCdkImport 签名
  // 压根不收 codes，结构上不可能把码写进 audit_log。
  db.recordAudit(
    actor,
    auditCdkImport({ itemId, itemName: item.name, faceValue, imported, skipped, availableBefore, availableAfter }),
  )
  return NextResponse.json({ ok: true, imported, skipped, available: availableAfter })
}

// 某项库存概览（导入后回看，不返回任何 code 值）
export async function GET(req: NextRequest) {
  if (!(await getAdminActor())) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const itemId = Number(new URL(req.url).searchParams.get('itemId'))
  if (!itemId) return NextResponse.json({ error: '缺 itemId' }, { status: 400 })
  return NextResponse.json({ ok: true, stats: db.cdkStatsFor(itemId) })
}
