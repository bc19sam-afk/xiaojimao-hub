'use client'

import { StackIcon, CheckCircleIcon, HourglassIcon, CoinsIcon } from '@phosphor-icons/react'

interface Contribution {
  verifyStatus: string
}

export default function StatCards({ list, balance }: { list: Contribution[]; balance: number }) {
  const total = list.length
  const pooled = list.filter((c) => c.verifyStatus === 'pooled').length
  // 进行中：submitted 待首检 / first_check 首检中（都还没入池、在走首检）
  const inProgress = list.filter(
    (c) => c.verifyStatus === 'submitted' || c.verifyStatus === 'first_check',
  ).length

  const stats = [
    { label: '已贡献', value: total, Icon: StackIcon, color: 'text-neutral-300' },
    // 「已入池」＝首检通过、入池计量中（pooled）。v4 无「已发分」终态——号持续按量计量，积分按账户累计。
    { label: '已入池', value: pooled, Icon: CheckCircleIcon, color: 'text-[var(--brand-bright)]' },
    { label: '进行中', value: inProgress, Icon: HourglassIcon, color: 'text-amber-300' },
    { label: '我的积分', value: balance, Icon: CoinsIcon, color: 'text-[var(--brand-bright)]' },
  ]

  return (
    <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className="min-w-0 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3.5"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5">
            <s.Icon size={18} weight="bold" className={s.color} />
          </div>
          <div className="min-w-0">
            <div className={`mono max-w-full break-all text-lg font-black leading-tight sm:text-xl ${s.color}`}>{s.value}</div>
            <div className="mt-1 truncate text-xs text-neutral-500">{s.label}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
