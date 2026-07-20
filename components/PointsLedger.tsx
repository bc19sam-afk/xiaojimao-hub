'use client'

import { ReceiptIcon } from '@phosphor-icons/react'

// 一笔积分明细：文案由服务端 describeLedgerEntry 生成（usage 笔已转「〔账号〕M 月 D 日 用量结算」，
// 账号掩码、无原始 ref/敏感号）。delta 正为加、负为扣。
interface LedgerItem {
  id: number
  delta: number
  createdAt: number
  text: string
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function PointsLedger({ ledger }: { ledger: LedgerItem[] }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <h3 className="mb-4 flex items-center gap-2 font-bold text-white">
        <ReceiptIcon size={18} weight="fill" className="text-[var(--brand-bright)]" />
        积分明细
      </h3>
      {ledger.length === 0 ? (
        <div className="py-6 text-center text-xs text-neutral-500">还没有积分记录</div>
      ) : (
        <ul className="max-h-[320px] space-y-1.5 overflow-y-auto">
          {ledger.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 text-xs">
              <div className="min-w-0">
                <div className="truncate text-neutral-300">{e.text}</div>
                <div className="mono text-[10px] text-neutral-600">{fmtTime(e.createdAt)}</div>
              </div>
              <span
                className={`mono shrink-0 font-semibold ${
                  e.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {e.delta >= 0 ? '+' : '−'}
                {Math.abs(e.delta)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
