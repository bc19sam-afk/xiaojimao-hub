'use client'

import { useEffect, useState } from 'react'
import { TrophyIcon, MedalIcon } from '@phosphor-icons/react'

interface Entry {
  linuxdoId: number
  username: string
  points: number
}
interface Me {
  linuxdoId: number
  rank: number
  points: number
}

// 前三名金银铜，其余数字
const MEDAL_COLOR = ['#facc15', '#cbd5e1', '#d19a66']

export default function Leaderboard({ refreshKey, meId }: { refreshKey: number; meId: number }) {
  const [list, setList] = useState<Entry[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/leaderboard', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        setList(d.list ?? [])
        setMe(d.me ?? null)
      })
      .finally(() => setLoading(false))
  }, [refreshKey])

  // 我在不在前 20 名里
  const meInList = list.some((e) => e.linuxdoId === meId)
  const showMeRow = me && me.points > 0 && !meInList

  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <h3 className="mb-4 flex items-center gap-2 font-bold text-white">
        <TrophyIcon size={18} weight="fill" className="text-[var(--brand-bright)]" />
        贡献排行榜
      </h3>
      {loading ? (
        <div className="py-8 text-center text-sm text-neutral-500">加载中…</div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8">
          <TrophyIcon size={28} weight="duotone" className="mb-3 text-neutral-700" />
          <div className="text-xs text-neutral-500">星图尚暗</div>
          <div className="mt-1 text-[11px] text-neutral-700">点亮第一颗星辰</div>
        </div>
      ) : (
        <ul className="space-y-1">
          {list.map((e, i) => {
            const isMe = e.linuxdoId === meId
            return (
              <li
                key={e.linuxdoId}
                className={`flex items-center justify-between rounded-xl px-3 py-2 transition ${
                  isMe
                    ? 'border border-[var(--brand)]/30 bg-[var(--brand)]/10'
                    : 'hover:bg-white/5'
                }`}
              >
                <div className="min-w-0 flex items-center gap-3">
                  <span className="flex w-6 justify-center">
                    {i < 3 ? (
                      <MedalIcon size={18} weight="fill" color={MEDAL_COLOR[i]} />
                    ) : (
                      <span className="mono text-xs text-neutral-500">{i + 1}</span>
                    )}
                  </span>
                  <span className={`min-w-0 truncate text-sm ${isMe ? 'font-semibold text-white' : 'text-neutral-200'}`}>
                    @{e.username}
                    {isMe && <span className="ml-1.5 text-[10px] text-[var(--brand-bright)]">你</span>}
                  </span>
                </div>
                <span className="mono text-sm font-bold text-[var(--brand-bright)]">{e.points} 分</span>
              </li>
            )
          })}

          {/* 我排在 20 名开外时，单独在底部展示「我的名次」 */}
          {showMeRow && me && (
            <>
              <li className="py-1 text-center text-[11px] text-neutral-600">···</li>
              <li className="flex items-center justify-between rounded-xl border border-[var(--brand)]/30 bg-[var(--brand)]/10 px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="mono flex w-6 justify-center text-xs text-neutral-400">
                    {me.rank}
                  </span>
                  <span className="text-sm font-semibold text-white">
                    你<span className="ml-1.5 text-[10px] text-[var(--brand-bright)]">当前名次</span>
                  </span>
                </div>
                <span className="mono text-sm font-bold text-[var(--brand-bright)]">{me.points} 分</span>
              </li>
            </>
          )}
        </ul>
      )}
    </div>
  )
}
