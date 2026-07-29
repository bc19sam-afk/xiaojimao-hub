import { NextRequest, NextResponse } from 'next/server'
import { getAdminActor } from '@/lib/admin'
import { db } from '@/lib/db'
import { auditRedeemItemUpsert, auditRedeemItemDelete } from '@/lib/audit'

const REDEEM_ITEM_SAVE_FAILURE = {
  ok: false,
  code: 'REDEEM_ITEM_SAVE_FAILED',
  error: '保存兑换项失败，请重试',
} as const

const REDEEM_ITEM_INVALID = {
  ok: false,
  code: 'REDEEM_ITEM_INVALID',
  error: '商品信息不完整',
} as const

const REDEEM_ITEM_DELETE_FAILURE = {
  ok: false,
  code: 'REDEEM_ITEM_DELETE_FAILED',
  error: '删除兑换项失败，请重试',
} as const

// 新增/更新兑换项
export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', error: '无权限' }, { status: 403 })
  }
  const b = await req.json().catch(() => null)
  if (!b || typeof b !== 'object' || !b.name || !b.kind) {
    return NextResponse.json(REDEEM_ITEM_INVALID, { status: 400 })
  }
  const id = b.id ? Number(b.id) : undefined
  const next = {
    id,
    name: String(b.name),
    description: String(b.description || ''),
    cost: Number(b.cost) || 0,
    kind: String(b.kind),
    enabled: b.enabled !== false,
    sort: Number(b.sort) || 0,
    config: typeof b.config === 'string' ? b.config : JSON.stringify(b.config ?? {}),
    // 履约类型（placeholder/cdk）+ 每人限购透传：未带则 upsert 里 COALESCE 保留原值 / 新建用默认。
    // 缺这俩透传＝导了 CDK 码也没入口把项激活成发码类（codex+bot 复审 P1：用户被扣分却只收占位、CDK 永不出库）。
    // 值域收敛（codex 复审 P2）：fulfillment 只认白名单——非法值（如 'cdk ' 带空格）会被 performRedeem
    // 的严格 ===' cdk' 当成 placeholder → 扣分却不发已导入的码；非白名单一律视作未传（undefined→保留原值/
    // 新建默认 placeholder）。perUserLimit 钳非负——负值绕过前端 min 会让 '>0' 限购判断失效＝变无限购。
    fulfillment: b.fulfillment === 'cdk' || b.fulfillment === 'placeholder' ? b.fulfillment : undefined,
    perUserLimit: b.perUserLimit != null ? Math.max(0, Number(b.perUserLimit) || 0) : undefined,
  }
  try {
    const result = db.withTransaction(() => {
      // 旧值、主写、审计和权威响应读回必须共享事务；任一步失败都回滚，客户端才可安全重试。
      const old = id ? db.getRedeemItem(id) : undefined
      db.upsertRedeemItem(next)
      db.recordAudit(actor, auditRedeemItemUpsert(old, next))
      return {
        redeemItems: db.listRedeemItems(false),
        overview: db.adminOverview(),
      }
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error('[admin] redeem item save failed', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json(REDEEM_ITEM_SAVE_FAILURE, { status: 500 })
  }
}

// 删除兑换项
export async function DELETE(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!id) return NextResponse.json({ error: '缺 id' }, { status: 400 })
  try {
    const result = db.withTransaction(() => {
      const old = db.getRedeemItem(id)
      db.deleteRedeemItem(id)
      db.recordAudit(actor, auditRedeemItemDelete(old, id))
      return {
        redeemItems: db.listRedeemItems(false),
        overview: db.adminOverview(),
      }
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error('[admin] redeem item delete failed', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json(REDEEM_ITEM_DELETE_FAILURE, { status: 500 })
  }
}
