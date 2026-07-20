'use client'

import { useCallback, useEffect, useState } from 'react'

interface PointRule {
  id: number
  provider: string
  plan: string
  points: number
  enabled: number
  label: string
}
interface RedeemItem {
  id: number
  name: string
  description: string
  cost: number
  kind: string
  enabled: number
  sort: number
  config: string
  fulfillment?: string
  perUserLimit?: number
}

const KINDS = [
  { v: 'timed_quota', t: '限时额度' },
  { v: 'permanent_quota', t: '永久额度' },
  { v: 'vip', t: '订阅VIP' },
  { v: 'invite_code', t: '邀请码' },
]
// 履约类型：placeholder 占位文案 / cdk 发码（后台先给该项导入 CDK 码，兑换时事务内占一个码发出）
const FULFILLMENTS = [
  { v: 'placeholder', t: '占位' },
  { v: 'cdk', t: 'CDK 发码' },
]

const field =
  'rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-emerald-400/50'

export default function AdminPanel() {
  const [rules, setRules] = useState<PointRule[]>([])
  const [items, setItems] = useState<RedeemItem[]>([])
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const d = await fetch('/api/admin/config', { cache: 'no-store' }).then((r) => r.json())
    setRules(d.pointRules ?? [])
    setItems(d.redeemItems ?? [])
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const flash = (t: string) => {
    setMsg(t)
    setTimeout(() => setMsg(''), 1500)
  }

  async function saveRule(r: Partial<PointRule>) {
    const res = await fetch('/api/admin/point-rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...r, enabled: r.enabled !== 0 }),
    })
    const d = await res.json()
    if (res.ok) {
      setRules(d.pointRules)
      flash('已保存')
    } else flash(d.error || '失败')
  }
  async function delRule(id: number) {
    const d = await fetch('/api/admin/point-rules?id=' + id, { method: 'DELETE' }).then((r) => r.json())
    setRules(d.pointRules)
    flash('已删除')
  }
  async function saveItem(it: Partial<RedeemItem>) {
    const res = await fetch('/api/admin/redeem-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...it, enabled: it.enabled !== 0 }),
    })
    const d = await res.json()
    if (res.ok) {
      setItems(d.redeemItems)
      flash('已保存')
    } else flash(d.error || '失败')
  }
  async function delItem(id: number) {
    const d = await fetch('/api/admin/redeem-items?id=' + id, { method: 'DELETE' }).then((r) => r.json())
    setItems(d.redeemItems)
    flash('已删除')
  }

  return (
    <main className="min-h-[100dvh] bg-neutral-950 px-4 py-8 text-neutral-200">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-bold text-white">管理后台</h1>
          <div className="flex items-center gap-3">
            {msg && <span className="text-xs text-emerald-400">{msg}</span>}
            <a href="/dashboard" className="text-sm text-neutral-400 hover:text-white">
              前台
            </a>
            <a
              href="/api/admin/logout"
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
            >
              退出
            </a>
          </div>
        </header>

        {/* 发分规则 */}
        <section className="mb-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">发分规则</h2>
          <p className="mb-4 text-xs text-neutral-500">
            账号验证通过后，按 (provider, 套餐) 发放积分。plan 填 <code>*</code> 作为该 provider 的兜底。改完点保存即时生效。
          </p>
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_80px_1.4fr_auto_auto] gap-2 text-[11px] text-neutral-500">
              <span>provider</span><span>plan</span><span>积分</span><span>标签</span><span>启用</span><span></span>
            </div>
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} onSave={saveRule} onDelete={() => delRule(r.id)} />
            ))}
            <RuleRow onSave={saveRule} isNew />
          </div>
        </section>

        {/* 兑换项 */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">兑换项（商店）</h2>
          <p className="mb-4 text-xs text-neutral-500">用户用积分兑换。履约接口后续接小鸡毛，现为占位。</p>
          <div className="space-y-2">
            <div className="grid grid-cols-[1.3fr_100px_1fr_1.4fr_auto_auto] gap-2 text-[11px] text-neutral-500">
              <span>名称</span><span>积分价</span><span>类型</span><span>说明</span><span>启用</span><span></span>
            </div>
            {items.map((it) => (
              <ItemRow key={it.id} item={it} onSave={saveItem} onDelete={() => delItem(it.id)} />
            ))}
            <ItemRow onSave={saveItem} isNew />
          </div>
        </section>
      </div>
    </main>
  )
}

function RuleRow({
  rule,
  onSave,
  onDelete,
  isNew,
}: {
  rule?: PointRule
  onSave: (r: Partial<PointRule>) => void
  onDelete?: () => void
  isNew?: boolean
}) {
  const [provider, setProvider] = useState(rule?.provider ?? '')
  const [plan, setPlan] = useState(rule?.plan ?? '')
  const [points, setPoints] = useState(rule?.points ?? 0)
  const [label, setLabel] = useState(rule?.label ?? '')
  const [enabled, setEnabled] = useState((rule?.enabled ?? 1) !== 0)

  return (
    <div className="grid grid-cols-[1fr_1fr_80px_1.4fr_auto_auto] items-center gap-2">
      <input className={field} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="codex" />
      <input className={field} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="plus / *" />
      <input className={field} type="number" value={points} onChange={(e) => setPoints(Number(e.target.value))} />
      <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签" />
      <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
      <div className="flex gap-1">
        <button
          onClick={() => onSave({ provider, plan, points, label, enabled: enabled ? 1 : 0 })}
          className="rounded-lg bg-[var(--brand)]/20 px-2.5 py-1.5 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
        >
          {isNew ? '新增' : '保存'}
        </button>
        {onDelete && (
          <button onClick={onDelete} className="rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20">
            删
          </button>
        )}
      </div>
    </div>
  )
}

function ItemRow({
  item,
  onSave,
  onDelete,
  isNew,
}: {
  item?: RedeemItem
  onSave: (it: Partial<RedeemItem>) => void
  onDelete?: () => void
  isNew?: boolean
}) {
  const [name, setName] = useState(item?.name ?? '')
  const [cost, setCost] = useState(item?.cost ?? 0)
  const [kind, setKind] = useState(item?.kind ?? 'timed_quota')
  const [fulfillment, setFulfillment] = useState(item?.fulfillment ?? 'placeholder')
  const [perUserLimit, setPerUserLimit] = useState(item?.perUserLimit ?? 0)
  const [description, setDescription] = useState(item?.description ?? '')
  const [enabled, setEnabled] = useState((item?.enabled ?? 1) !== 0)

  return (
    <div className="grid grid-cols-[1.2fr_80px_1fr_1fr_72px_1.2fr_auto_auto] items-center gap-2">
      <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
      <input className={field} type="number" value={cost} onChange={(e) => setCost(Number(e.target.value))} />
      <select className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
        {KINDS.map((k) => (
          <option key={k.v} value={k.v}>
            {k.t}
          </option>
        ))}
      </select>
      <select className={field} value={fulfillment} onChange={(e) => setFulfillment(e.target.value)} title="履约类型">
        {FULFILLMENTS.map((f) => (
          <option key={f.v} value={f.v}>
            {f.t}
          </option>
        ))}
      </select>
      <input
        className={field}
        type="number"
        min={0}
        value={perUserLimit}
        onChange={(e) => setPerUserLimit(Number(e.target.value))}
        title="每人限购（0=不限）"
        placeholder="限购"
      />
      <input className={field} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="说明" />
      <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
      <div className="flex gap-1">
        <button
          onClick={() =>
            onSave({ id: item?.id, name, cost, kind, fulfillment, perUserLimit, description, sort: item?.sort ?? 0, enabled: enabled ? 1 : 0 })
          }
          className="rounded-lg bg-[var(--brand)]/20 px-2.5 py-1.5 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
        >
          {isNew ? '新增' : '保存'}
        </button>
        {onDelete && (
          <button onClick={onDelete} className="rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20">
            删
          </button>
        )}
      </div>
    </div>
  )
}
