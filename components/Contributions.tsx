'use client'

import { ArrowsClockwiseIcon, ShieldCheckIcon, WarningCircleIcon } from '@phosphor-icons/react'

interface Contribution {
  id: string
  accountId: string
  email: string
  provider: string
  plan: string
  method: 'oauth' | 'rt'
  verifyStatus: 'submitted' | 'first_check' | 'pooled' | 'stopped' | 'needs_review'
  points: number
  cumulativePoints?: number // v4：该号累计赚的分（daily_settlements 汇总，§4/§6）
  createdAt: number
}

// 首检退回记录（§3.2）：账号已由服务端掩码成 provider+短标识
interface Rejection {
  id: number
  account: string
  reason: string
  createdAt: number
}

// 需求 §3.2 五态（v4 按量计量，考察期取消）中文。§4/§3.5 用户视角措辞：pooled=在用、stopped=已失效。
const VERIFY: Record<string, { label: string; cls: string }> = {
  submitted: { label: '已提交', cls: 'bg-amber-400/15 text-amber-300' },
  first_check: { label: '首检中', cls: 'bg-sky-400/15 text-sky-300' },
  pooled: { label: '在用', cls: 'bg-emerald-400/15 text-emerald-300' },
  stopped: { label: '已失效', cls: 'bg-rose-400/15 text-rose-300' },
  needs_review: { label: '待人工复核', cls: 'bg-orange-400/15 text-orange-300' },
}

export default function Contributions({
  list,
  rejections = [],
  loading,
  onReload,
}: {
  list: Contribution[]
  rejections?: Rejection[]
  loading: boolean
  onReload: () => void
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold text-white">我的贡献记录</h3>
        <div className="flex gap-2">
          <button
            onClick={onReload}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10"
          >
            <ArrowsClockwiseIcon size={14} weight="bold" />
            刷新
          </button>
        </div>
      </div>

      {/* 首检退回提示（§3.2）：号被退回后从下表消失，这里告知「交了但没收、可修好重交」 */}
      {rejections.length > 0 && (
        <div className="mb-4 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-rose-300">
            <WarningCircleIcon size={14} weight="fill" />
            部分号未收下（修好可重新提交）
          </div>
          <ul className="space-y-1">
            {rejections.map((r) => (
              <li key={r.id} className="text-[11px] leading-relaxed text-rose-200/80">
                <span className="mono text-rose-200">〔{r.account}〕</span>
                {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

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
        <div className="max-h-[420px] max-w-full overflow-x-auto overflow-y-auto rounded-xl border border-white/5">
          <table className="w-full min-w-[34rem] table-fixed text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-white/10 bg-[var(--ink-soft)] text-left text-xs text-neutral-500">
                <th className="w-[44%] px-4 py-2.5 font-medium">账号</th>
                <th className="w-[14%] px-4 py-2.5 font-medium">类型</th>
                <th className="w-[22%] px-4 py-2.5 font-medium">状态</th>
                <th className="w-[20%] px-4 py-2.5 font-medium">累计积分</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const v = VERIFY[c.verifyStatus] ?? VERIFY.submitted
                const pts = c.cumulativePoints ?? 0
                return (
                  <tr key={c.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3">
                      <div className="mono break-all text-xs text-neutral-300">{c.email || c.accountId}</div>
                      <div className="mono mt-0.5 break-all text-[10px] uppercase text-neutral-600">
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
                      {/* v4：该号累计赚的分（daily_settlements 汇总）。0＝尚无已结算日 */}
                      {pts > 0 ? (
                        <span className="mono text-xs font-semibold text-[var(--brand-bright)]">{pts}</span>
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
