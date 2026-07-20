'use client'

import { useCallback, useEffect, useState } from 'react'
import CollectPanel from './CollectPanel'
import Contributions from './Contributions'
import Leaderboard from './Leaderboard'
import StatCards from './StatCards'
import RedeemStore from './RedeemStore'
import { OpenAIMark } from './OpenAIMark'
import StarField from './StarField'
import NebulaBackground from './NebulaBackground'

interface Contribution {
  id: string
  accountId: string
  email: string
  provider: string
  plan: string
  method: 'oauth' | 'rt'
  verifyStatus: 'submitted' | 'first_check' | 'pooled' | 'stopped' | 'needs_review'
  points: number
  createdAt: number
}

export default function DashboardShell({
  user,
}: {
  user: { id: number; username: string; name?: string; trustLevel: number }
}) {
  const [list, setList] = useState<Contribution[]>([])
  const [loading, setLoading] = useState(true)
  const [balance, setBalance] = useState(0)
  const [lbKey, setLbKey] = useState(0)
  const [storeKey, setStoreKey] = useState(0)

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      fetch('/api/my-contributions', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])),
      fetch('/api/store', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { balance: 0 })),
    ])
    setList(c)
    setBalance(s.balance ?? 0)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 有首检中的号时自动快轮询，让后台首检结果实时显现（首检态几秒内出结果）。v4 下 pooled 态不由本页
  // worker 变动（按日计量＝R2、失效巡检＝R3），故入池后无需慢轮询。
  useEffect(() => {
    const hasFastChanging = list.some(
      (c) => c.verifyStatus === 'submitted' || c.verifyStatus === 'first_check',
    )
    if (!hasFastChanging) return
    const t = setInterval(() => {
      load()
      setLbKey((k) => k + 1)
      setStoreKey((k) => k + 1)
    }, 5000)
    return () => clearInterval(t)
  }, [list, load])

  const afterChange = useCallback(() => {
    load()
    setLbKey((k) => k + 1)
    setStoreKey((k) => k + 1)
  }, [load])

  return (
    <main className="bg-ink relative min-h-screen overflow-hidden">
      <NebulaBackground />
      <StarField />
      <div className="bg-grid absolute inset-0" />

      <div className="relative mx-auto max-w-6xl px-4 py-8">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-[var(--ink-soft)]">
              <OpenAIMark className="h-5 w-5 text-white" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-bold text-white">OpenAI Plus 收集系统</div>
              <div className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--brand-bright)]">
                小鸡毛の公益宇宙
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="mono hidden text-xs text-neutral-400 sm:inline">
              @{user.username} · L{user.trustLevel}
            </span>
            <a
              href="/api/auth/logout"
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-white/10"
            >
              退出
            </a>
          </div>
        </header>

        {/* 统计头 */}
        <div className="mb-6">
          <StatCards list={list} balance={balance} />
        </div>

        {/* 左右栏 */}
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <CollectPanel onDone={afterChange} />
            <Contributions
              list={list}
              loading={loading}
              onReload={load}
              onVerified={afterChange}
            />
          </div>
          <div className="space-y-6">
            <RedeemStore refreshKey={storeKey} onRedeemed={afterChange} />
            <Leaderboard refreshKey={lbKey} meId={user.id} />
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <h3 className="mb-4 font-bold text-white">运作原理</h3>
              <ol className="space-y-3 text-sm leading-relaxed text-neutral-400">
                {[
                  '授权你的账号（ChatGPT / Claude / Grok）',
                  '系统自动巡检账号可用性',
                  '通过后入池，按类型发放积分',
                  '积分到兑换商店换东西',
                ].map((t, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="mono flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--brand)]/30 bg-[var(--brand)]/10 text-[11px] font-bold text-[var(--brand-bright)]">
                      {i + 1}
                    </span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
