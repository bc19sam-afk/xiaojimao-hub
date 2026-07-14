import { randomBytes } from 'crypto'
import { db } from './db'

// ============================================================================
// 兑换：花积分换东西。原子扣分（余额不足则失败），再履约。
// 履约目前是占位（生成一个占位结果串）；将来接小鸡毛的发码/加额度接口只改这里。
// ============================================================================

function fulfill(kind: string): { status: 'fulfilled' | 'pending'; result: string } {
  // TODO(real): 按 kind 调小鸡毛对应接口（永久额度/限时额度/VIP/邀请码）
  switch (kind) {
    case 'invite_code':
      return { status: 'fulfilled', result: `XJM-INV-${randomBytes(3).toString('hex').toUpperCase()}` }
    case 'permanent_quota':
    case 'timed_quota':
    case 'vip':
    default:
      return { status: 'fulfilled', result: '已发放（占位，待接小鸡毛履约）' }
  }
}

export function redeem(
  linuxdoId: number,
  itemId: number,
): { ok: true; result: string; balance: number } | { ok: false; error: string } {
  const item = db.getRedeemItem(itemId)
  if (!item || item.enabled === 0) return { ok: false, error: '该兑换项不存在或已下架' }

  const redemptionId = randomBytes(8).toString('hex')
  // 原子扣分：余额不足直接失败，绝不透支
  const spent = db.spendPoints(linuxdoId, item.cost, 'redeem', redemptionId)
  if (!spent) return { ok: false, error: '积分不足' }

  // 记录 + 履约
  db.createRedemption({
    id: redemptionId,
    linuxdoId,
    itemId: item.id,
    itemName: item.name,
    cost: item.cost,
    status: 'pending',
  })
  const f = fulfill(item.kind)
  db.updateRedemption(redemptionId, { status: f.status, result: f.result })

  return { ok: true, result: f.result, balance: db.balance(linuxdoId) }
}
