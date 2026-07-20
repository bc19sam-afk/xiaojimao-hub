import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { db, describeLedgerEntry } from '@/lib/db'

// 用户端商店：积分余额 + 可兑换项 + 我的兑换记录 + 积分明细
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
  // 积分明细（§6）：usage 笔的 ref（'usage:<cid>:日期'）解析成人话「〔账号〕M 月 D 日 用量结算」——
  // 账号由 cid 回查本人号表、掩码成 provider+短标识；服务端只外发 { delta, 时间, 文案 }，不外发完整
  // 敏感号 / 原始 ref（§8）。其它 reason（redeem / 贡献老笔）给稳定中文。
  const acctById = new Map(
    db.byUser(user.id).map((c) => [c.id, { provider: c.provider, accountId: c.accountId }]),
  )
  const ledger = db.ledgerFor(user.id).map((e) => ({
    id: e.id,
    delta: e.delta,
    createdAt: e.createdAt,
    text: describeLedgerEntry(e, (cid) => acctById.get(cid)),
  }))
  return NextResponse.json({
    balance: db.balance(user.id),
    items: db.listRedeemItems(true),
    redemptions: db.listRedemptions(user.id),
    ledger,
  })
}
