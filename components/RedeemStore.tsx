'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CoinsIcon, GiftIcon } from '@phosphor-icons/react'

interface Item {
  id: number
  name: string
  description: string
  cost: number
  kind: string
  soldOut?: boolean
}
interface Redemption {
  id: string
  itemName: string
  cost: number
  status: string
  result: string
  createdAt: number
}

export default function RedeemStore({ refreshKey, onRedeemed }: { refreshKey: number; onRedeemed: () => void }) {
  const [balance, setBalance] = useState(0)
  const [items, setItems] = useState<Item[]>([])
  const [redemptions, setRedemptions] = useState<Redemption[]>([])
  const [busy, setBusy] = useState(0)
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  // 每项一枚幂等 token：兑换手势首次生成、收到定论（成功/业务拒绝）即清、网络错误保留供重试复用——
  // 让重复点击/超时重试落到同一 token → 服务端幂等回放、不重复扣分。
  const tokens = useRef<Record<number, string>>({})

  const load = useCallback(async () => {
    const d = await fetch('/api/store', { cache: 'no-store' }).then((r) => r.json())
    if (d.balance !== undefined) {
      setBalance(d.balance)
      setItems(d.items ?? [])
      setRedemptions(d.redemptions ?? [])
    }
  }, [])
  useEffect(() => {
    load()
  }, [load, refreshKey])

  async function redeem(item: Item) {
    setBusy(item.id)
    setToast(null)
    const token = tokens.current[item.id] ?? (tokens.current[item.id] = crypto.randomUUID())
    try {
      const res = await fetch('/api/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, token }),
      })
      const d = await res.json().catch(() => ({}))
      // 收到响应（成功或业务拒绝）＝本次尝试有定论 → 清 token，下次兑换用新 token；
      // 若 fetch 直接抛（网络/超时、无响应）则跳过此清除，token 保留供重试复用（超时重试幂等）。
      delete tokens.current[item.id]
      if (!res.ok) throw new Error(d.error || '兑换失败')
      setToast({ ok: true, text: `已兑换「${item.name}」` })
      await load()
      onRedeemed()
    } catch (e) {
      setToast({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(0)
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      setToast({ ok: true, text: '已复制到剪贴板' })
    } catch {
      setToast({ ok: false, text: '复制失败，请手动选择' })
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-bold text-white">
          <GiftIcon size={18} weight="fill" className="text-[var(--brand-bright)]" />
          兑换商店
        </h3>
        <div className="flex items-center gap-1.5 rounded-full bg-[var(--brand)]/10 px-3 py-1">
          <CoinsIcon size={15} weight="fill" className="text-[var(--brand-bright)]" />
          <span className="mono text-sm font-bold text-[var(--brand-bright)]">{balance}</span>
          <span className="text-xs text-neutral-400">积分</span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="py-6 text-center text-xs text-neutral-500">暂无可兑换项</div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const affordable = balance >= it.cost
            const canBuy = affordable && !it.soldOut
            return (
              <div
                key={it.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-neutral-100">{it.name}</div>
                  {it.description && (
                    <div className="truncate text-[11px] text-neutral-500">{it.description}</div>
                  )}
                </div>
                <button
                  onClick={() => redeem(it)}
                  disabled={busy === it.id || !canBuy}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    canBuy
                      ? 'bg-[var(--brand)] text-white hover:bg-[var(--brand-bright)]'
                      : 'cursor-not-allowed bg-white/5 text-neutral-500'
                  } disabled:opacity-60`}
                >
                  {it.soldOut ? '已兑罄' : busy === it.id ? '兑换中…' : `${it.cost} 分`}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {toast && (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs ${
            toast.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
          }`}
        >
          {toast.text}
        </div>
      )}

      {redemptions.length > 0 && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <div className="mb-2 text-[11px] text-neutral-500">兑换记录</div>
          <ul className="space-y-1.5">
            {redemptions.slice(0, 5).map((r) => {
              // 码类结果（CDK / 占位邀请码）为可打印 ASCII → 显示可复制码（§5.3「响应丢失可在兑换记录找回」）；
              // 中文占位串（「已发放（占位…）」）不当码显示。
              const isCode = !!r.result && /^[\x21-\x7e]+$/.test(r.result)
              return (
                <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-neutral-300">{r.itemName}</span>
                  <span className="mono flex items-center gap-2 text-neutral-500">
                    −{r.cost}
                    {isCode && (
                      <button
                        onClick={() => copyCode(r.result)}
                        title="点击复制"
                        className="max-w-[10rem] truncate rounded bg-[var(--brand)]/15 px-1.5 py-0.5 text-[var(--brand-bright)] hover:bg-[var(--brand)]/25"
                      >
                        {r.result}
                      </button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
