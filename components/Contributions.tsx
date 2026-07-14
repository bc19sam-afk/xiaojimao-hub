'use client'

import { useState } from 'react'
import { ArrowsClockwiseIcon, ShieldCheckIcon } from '@phosphor-icons/react'

interface Contribution {
  id: string
  accountId: string
  email: string
  provider: string
  plan: string
  method: 'oauth' | 'rt'
  verifyStatus: 'pending' | 'verifying' | 'active' | 'rejected' | 'duplicate' | 'quarantined' | 'reauth'
  points: number
  createdAt: number
}

const VERIFY: Record<string, { label: string; cls: string }> = {
  pending: { label: '待验证', cls: 'bg-amber-400/15 text-amber-300' },
  verifying: { label: '验证中', cls: 'bg-sky-400/15 text-sky-300' },
  quarantined: { label: '复检中', cls: 'bg-amber-400/15 text-amber-300' },
  reauth: { label: '需重新授权', cls: 'bg-orange-400/15 text-orange-300' },
  active: { label: '已入池', cls: 'bg-emerald-400/15 text-emerald-300' },
  rejected: { label: '验证失败', cls: 'bg-rose-400/15 text-rose-300' },
  duplicate: { label: '重复账号', cls: 'bg-slate-400/15 text-slate-300' },
}

export default function Contributions({
  list,
  loading,
  onReload,
  onVerified,
}: {
  list: Contribution[]
  loading: boolean
  onReload: () => void
  onVerified: () => void
}) {
  const [verifying, setVerifying] = useState(false)

  async function verifyNow() {
    setVerifying(true)
    try {
      await fetch('/api/verify-now', { method: 'POST' })
      onVerified()
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-bold text-white">我的贡献记录</h3>
        <div className="flex gap-2">
          <button
            onClick={verifyNow}
            disabled={verifying}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/20 disabled:opacity-50"
          >
            <ShieldCheckIcon size={14} weight="bold" />
            {verifying ? '验证中…' : '立即验证'}
          </button>
          <button
            onClick={onReload}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10"
          >
            <ArrowsClockwiseIcon size={14} weight="bold" />
            刷新
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-neutral-500">加载中…</div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 py-16">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.02]">
            <ShieldCheckIcon size={26} weight="duotone" className="text-neutral-600" />
          </div>
          <div className="text-sm font-medium text-neutral-300">还没有贡献记录</div>
          <div className="mt-1.5 max-w-xs text-center text-xs leading-relaxed text-neutral-600">
            点击上方「授权」贡献你的第一个账号，
            <br />
            验证通过后即可获得积分
          </div>
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto rounded-xl border border-white/5">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-white/10 bg-[var(--ink-soft)] text-left text-xs text-neutral-500">
                <th className="px-4 py-2.5 font-medium">账号</th>
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="px-4 py-2.5 font-medium">验证状态</th>
                <th className="px-4 py-2.5 font-medium">积分</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const v = VERIFY[c.verifyStatus] ?? VERIFY.pending
                return (
                  <tr key={c.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3">
                      <div className="mono text-xs text-neutral-300">{c.email || c.accountId}</div>
                      <div className="mono mt-0.5 text-[10px] uppercase text-neutral-600">
                        {c.provider} · {c.plan}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-400">
                      {c.method === 'oauth' ? 'OAuth' : 'RT'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${v.cls}`}>
                        {v.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {c.verifyStatus === 'active' && c.points > 0 ? (
                        <span className="mono text-sm font-bold text-[var(--brand-bright)]">
                          +{c.points}
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-600">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
