'use client'

import { useCallback, useEffect, useState } from 'react'
import CollectPanel from './CollectPanel'
import Contributions from './Contributions'
import Leaderboard from './Leaderboard'
import StatCards from './StatCards'
import RedeemStore from './RedeemStore'
import PointsLedger from './PointsLedger'
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
  cumulativePoints?: number // v4：该号累计赚的分（§4/§6）
  createdAt: number
}
interface Rejection {
  id: number
  account: string
  reason: string
  createdAt: number
}
interface LedgerItem {
  id: number
  delta: number
  createdAt: number
  text: string
}

export default function DashboardShell({
  user,
}: {
  user: { id: number; username: string; name?: string; trustLevel: number }
}) {
  const [list, setList] = useState<Contribution[]>([])
  const [rejections, setRejections] = useState<Rejection[]>([])
  const [ledger, setLedger] = useState<LedgerItem[]>([])
  const [loading, setLoading] = useState(true)
  const [balance, setBalance] = useState(0)
  const [lbKey, setLbKey] = useState(0)
  const [storeKey, setStoreKey] = useState(0)

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      fetch('/api/my-contributions', { cache: 'no-store' }).then((r) =>
        r.ok ? r.json() : { contributions: [], rejections: [] },
      ),
      fetch('/api/store', { cache: 'no-store' }).then((r) =>
        r.ok ? r.json() : { balance: 0, ledger: [] },
      ),
    ])
    setList(c.contributions ?? [])
    setRejections(c.rejections ?? [])
    setBalance(s.balance ?? 0)
    setLedger(s.ledger ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 首检中的号 → 5s 快轮询（首检态几秒出结果）；有 pooled 号 → 30s 慢轮询——R3 的存活巡检会把
  // pooled 背景转 stopped/needs_review、R2 按日结算也背景加分/改累计，不轮询则一直显示「在用」、
  // 余额/明细停更直到手动刷新（GitHub bot 于 PR #18 指出）。快慢并存时取快（5s）。
  useEffect(() => {
    const hasFastChanging = list.some(
      (c) => c.verifyStatus === 'submitted' || c.verifyStatus === 'first_check',
    )
    const hasPooled = list.some((c) => c.verifyStatus === 'pooled')
    if (!hasFastChanging && !hasPooled) return
    const t = setInterval(
      () => {
        load()
        setLbKey((k) => k + 1)
        setStoreKey((k) => k + 1)
      },
      hasFastChanging ? 5000 : 30_000,
    )
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
              rejections={rejections}
              loading={loading}
              onReload={load}
              onVerified={afterChange}
            />
          </div>
          <div className="space-y-6">
            <RedeemStore refreshKey={storeKey} onRedeemed={afterChange} />
            <PointsLedger ledger={ledger} />
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
