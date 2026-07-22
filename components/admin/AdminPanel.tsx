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
// 折算规则（按次单价，P4-R2 §3.4）：pointsPerCall 可小数（usage_rates.points_per_call REAL）
interface UsageRate {
  id: number
  provider: string
  plan: string
  pointsPerCall: number
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
// 审计日志一行（P4-R1，§7.3）：old/new 为已脱敏 JSON 摘要串（绝不含码/密钥），查看侧原样展示不泄敏感值
interface AuditRow {
  id: number
  actorType: string
  actorId: number | null
  actorLabel: string
  action: string
  target: string
  oldValue: string | null
  newValue: string | null
  createdAt: number
}
interface CdkStats {
  available: number
  issued: number
  void: number
}
// ===== 数据查看（P4-R3，§6.146）：管理侧全局分页只读 =====
interface ContributionRow {
  id: string
  linuxdoId: number
  username: string
  provider: string
  plan: string
  accountId: string
  verifyStatus: string
  points: number
  createdAt: number
}
interface SettlementRow {
  id: number
  contributionId: string
  linuxdoId: number | null
  username: string
  date: string
  provider: string
  accountId: string
  callCount: number
  points: number
  settledAt: number
}
// 兑换记录一行：后端已脱敏，绝不含 result（CDK 码原文，§8）
interface RedemptionRow {
  id: string
  linuxdoId: number
  username: string
  itemName: string
  cost: number
  status: string
  createdAt: number
}
// 待人工复核队列一行（needs_review，§7.4）
interface ReviewRow {
  id: string
  linuxdoId: number
  username: string
  provider: string
  accountId: string
  createdAt: number
  updatedAt: number
}

const KINDS = [
  { v: 'timed_quota', t: '限时额度' },
  { v: 'permanent_quota', t: '永久额度' },
  { v: 'vip', t: '订阅VIP' },
  { v: 'invite_code', t: '邀请码' },
  { v: 'ldc', t: 'LDC' }, // P3-R2：合伙人 linux.do 币，配 CDK 发码 + 每日限量（码带面额）
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
  const [rates, setRates] = useState<UsageRate[]>([]) // 折算规则（按次单价）
  const [items, setItems] = useState<RedeemItem[]>([])
  const [quota, setQuota] = useState('') // LDC 每日额度（受控输入，字符串）
  const [gateEnabled, setGateEnabled] = useState(true) // 信任门槛开关（缺省启用）
  const [minTrust, setMinTrust] = useState('') // 信任门槛数值（受控输入，字符串）
  const [graceMinutes, setGraceMinutes] = useState('') // 结算时刻：午夜后分钟（受控输入，字符串）
  const [poolPriority, setPoolPriority] = useState('') // 入池优先级（受控输入，字符串）
  const [audit, setAudit] = useState<AuditRow[]>([])
  // 数据查看 + 人工复核（P4-R3）
  const [contributions, setContributions] = useState<ContributionRow[]>([])
  const [settlements, setSettlements] = useState<SettlementRow[]>([])
  const [redemptions, setRedemptions] = useState<RedemptionRow[]>([])
  const [review, setReview] = useState<ReviewRow[]>([])
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const d = await fetch('/api/admin/config', { cache: 'no-store' }).then((r) => r.json())
    setRules(d.pointRules ?? [])
    setItems(d.redeemItems ?? [])
  }, [])
  const loadRates = useCallback(async () => {
    const d = await fetch('/api/admin/usage-rates', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setRates(d.usageRates ?? [])
  }, [])
  const loadQuota = useCallback(async () => {
    const d = await fetch('/api/admin/ldc-quota', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setQuota(String(d.quota))
  }, [])
  const loadGate = useCallback(async () => {
    const d = await fetch('/api/admin/trust-gate', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) {
      setGateEnabled(d.enabled)
      setMinTrust(String(d.minTrust))
    }
  }, [])
  const loadSettle = useCallback(async () => {
    const d = await fetch('/api/admin/settle-params', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setGraceMinutes(String(d.graceMinutes))
  }, [])
  const loadPool = useCallback(async () => {
    const d = await fetch('/api/admin/pool-priority', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setPoolPriority(String(d.poolPriority))
  }, [])
  const loadAudit = useCallback(async () => {
    const d = await fetch('/api/admin/audit?limit=50', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setAudit(d.audit ?? [])
  }, [])
  // 数据查看三块：各拉一页（limit=50）。§8——兑换记录后端已脱敏，不含 result
  const loadContributions = useCallback(async () => {
    const d = await fetch('/api/admin/contributions?limit=50', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setContributions(d.contributions ?? [])
  }, [])
  const loadSettlements = useCallback(async () => {
    const d = await fetch('/api/admin/settlements?limit=50', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setSettlements(d.settlements ?? [])
  }, [])
  const loadRedemptions = useCallback(async () => {
    const d = await fetch('/api/admin/redemptions?limit=50', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setRedemptions(d.redemptions ?? [])
  }, [])
  const loadReview = useCallback(async () => {
    const d = await fetch('/api/admin/review', { cache: 'no-store' }).then((r) => r.json())
    if (d.ok) setReview(d.review ?? [])
  }, [])
  useEffect(() => {
    load()
    loadRates()
    loadQuota()
    loadGate()
    loadSettle()
    loadPool()
    loadAudit()
    loadContributions()
    loadSettlements()
    loadRedemptions()
    loadReview()
  }, [
    load, loadRates, loadQuota, loadGate, loadSettle, loadPool, loadAudit,
    loadContributions, loadSettlements, loadRedemptions, loadReview,
  ])

  const flash = (t: string) => {
    setMsg(t)
    setTimeout(() => setMsg(''), 1500)
  }

  async function saveQuota() {
    if (quota.trim() === '') {
      flash('额度须为非负整数')
      return
    }
    const n = Number(quota)
    if (!Number.isSafeInteger(n) || n < 0) {
      flash('额度须为非负整数')
      return
    }
    const res = await fetch('/api/admin/ldc-quota', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quota: n }),
    })
    const d = await res.json()
    if (res.ok) {
      setQuota(String(d.quota))
      flash('已保存')
      loadAudit()
    } else flash(d.error || '失败')
  }

  async function saveGate() {
    const n = Number(minTrust)
    if (minTrust.trim() === '' || !Number.isSafeInteger(n) || n < 0) {
      flash('门槛须为非负整数')
      return
    }
    const res = await fetch('/api/admin/trust-gate', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: gateEnabled, minTrust: n }),
    })
    const d = await res.json()
    if (res.ok) {
      setGateEnabled(d.enabled)
      setMinTrust(String(d.minTrust))
      flash('已保存')
      loadAudit()
    } else flash(d.error || '失败')
  }

  async function saveSettle() {
    const n = Number(graceMinutes)
    if (graceMinutes.trim() === '' || !Number.isSafeInteger(n) || n < 0 || n > 1439) {
      flash('结算时刻须为 0–1439 分钟')
      return
    }
    const res = await fetch('/api/admin/settle-params', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graceMinutes: n }),
    })
    const d = await res.json()
    if (res.ok) {
      setGraceMinutes(String(d.graceMinutes))
      flash('已保存')
      loadAudit()
    } else flash(d.error || '失败')
  }

  async function savePool() {
    const n = Number(poolPriority)
    if (poolPriority.trim() === '' || !Number.isSafeInteger(n) || n < 0) {
      flash('优先级须为非负整数')
      return
    }
    const res = await fetch('/api/admin/pool-priority', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poolPriority: n }),
    })
    const d = await res.json()
    if (res.ok) {
      setPoolPriority(String(d.poolPriority))
      flash('已保存')
      loadAudit()
    } else flash(d.error || '失败')
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
  async function saveRate(r: Partial<UsageRate>) {
    const res = await fetch('/api/admin/usage-rates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...r, enabled: r.enabled !== 0 }),
    })
    const d = await res.json()
    if (res.ok) {
      setRates(d.usageRates)
      flash('已保存')
      loadAudit()
    } else flash(d.error || '失败')
  }
  async function delRate(id: number) {
    const d = await fetch('/api/admin/usage-rates?id=' + id, { method: 'DELETE' }).then((r) => r.json())
    setRates(d.usageRates)
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

  // 人工复核处理（P4-R3，§7.4）：重试（按是否入过池分叉：未入过→回首检 / 入过→直接回池）/ 终止（→ 停用）。
  // 成功后刷新队列 + 审计 + **贡献记录表**（codex 复审 P3：否则贡献表仍显示旧 needs_review 直到手动刷新）。
  // 后端 CAS 返回 { ok:false, error:'状态已变' }（HTTP 200）时按失败提示，不改队列。
  async function doReview(id: string, action: 'retry' | 'terminate') {
    const res = await fetch('/api/admin/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    })
    const d = await res.json()
    if (res.ok && d.ok) {
      setReview(d.review ?? [])
      flash(action === 'retry' ? '已重试' : '已终止')
      loadAudit()
      loadContributions()
    } else flash(d.error || '失败')
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

        {/* 折算规则（按次单价，P4-R2 §3.4）：按 (provider, 套餐) 每次调用积分单价，可小数。plan 填 * 作兜底 */}
        <section className="mb-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">折算规则（按次单价）</h2>
          <p className="mb-4 text-xs text-neutral-500">
            号在池后，按 cpamp 每日调用量折算积分：结算 = round(次数 × 单价)。单价可小数（如 <code>0.5</code>）。plan 填{' '}
            <code>*</code> 作该 provider 的兜底。改完点保存即时生效。改 <code>provider</code>/<code>plan</code> 需先删旧行再新增。
          </p>
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_80px_1.4fr_auto_auto] gap-2 text-[11px] text-neutral-500">
              <span>provider</span><span>plan</span><span>单价</span><span>标签</span><span>启用</span><span></span>
            </div>
            {rates.map((r) => (
              <RateRow key={r.id} rate={r} onSave={saveRate} onDelete={() => delRate(r.id)} />
            ))}
            <RateRow onSave={saveRate} isNew />
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

        {/* CDK 库存导入（P4-R1）：选项 + 贴码 + 面额 → 导入；只回计数/库存，绝不回显已导入的码 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">CDK 库存导入</h2>
          <p className="mb-4 text-xs text-neutral-500">
            给「CDK 发码」履约的兑换项预导入码（一行一码 / 逗号 / 空白分隔，跨批自动去重）。
            <span className="text-amber-300/80">LDC 商品必填正整数面额（一批同面额）。</span>
            安全起见，导入后只显示计数与库存，<b>不回显任何码</b>。
          </p>
          <CdkImport items={items} onDone={loadAudit} flash={flash} />
        </section>

        {/* LDC 每日额度（P4-R1）：读改 app_config['ldc_daily_quota']，缺省 2000 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">LDC 每日额度</h2>
          <p className="mb-4 text-xs text-neutral-500">
            当日已发 LDC 面额之和的上限（按服务器本地自然日重置）。0＝当日停发。非负整数。
          </p>
          <div className="flex items-center gap-2">
            <input
              className={field + ' w-40'}
              type="number"
              min={0}
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              placeholder="2000"
            />
            <button
              onClick={saveQuota}
              className="rounded-lg bg-[var(--brand)]/20 px-3 py-1.5 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
            >
              保存
            </button>
          </div>
        </section>

        {/* 信任等级门槛 & 限身份开关（P4-R2 §1）：关＝登录即可、不限等级；开则等级不足拒登录（不使已登录会话失效） */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">信任等级门槛</h2>
          <p className="mb-4 text-xs text-neutral-500">
            控制谁能登录贡献账号。关闭门槛＝登录即可、不限信任等级；开启则 linux.do 信任等级低于门槛者被拒。
            调整只影响此后登录，不使已登录会话失效。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={gateEnabled}
                onChange={(e) => setGateEnabled(e.target.checked)}
                className="h-4 w-4 accent-emerald-500"
              />
              {gateEnabled ? '限信任等级' : '登录即可（不限）'}
            </label>
            <input
              className={field + ' w-40' + (gateEnabled ? '' : ' opacity-40')}
              type="number"
              min={0}
              value={minTrust}
              onChange={(e) => setMinTrust(e.target.value)}
              disabled={!gateEnabled}
              placeholder="门槛等级，如 1"
            />
            <button
              onClick={saveGate}
              className="rounded-lg bg-[var(--brand)]/20 px-3 py-1.5 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
            >
              保存
            </button>
          </div>
        </section>

        {/* 结算参数（P4-R2 §3.3）：结算时刻＝午夜后延迟分钟数，缺省 10（00:10）。时区随服务器不可配 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">结算参数</h2>
          <p className="mb-4 text-xs text-neutral-500">
            每日结算前一自然日的用量。结算时刻＝午夜后延迟多少分钟再结（吸收迟到落账），缺省 <code>10</code>（即 00:10）。
            范围 0–1439 分钟。<span className="text-amber-300/80">时区随服务器，不可配。</span>
          </p>
          <div className="flex items-center gap-2">
            <input
              className={field + ' w-40'}
              type="number"
              min={0}
              max={1439}
              value={graceMinutes}
              onChange={(e) => setGraceMinutes(e.target.value)}
              placeholder="10"
            />
            <span className="text-xs text-neutral-500">分钟（午夜后）</span>
            <button
              onClick={saveSettle}
              className="rounded-lg bg-[var(--brand)]/20 px-3 py-1.5 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
            >
              保存
            </button>
          </div>
        </section>

        {/* 入池优先级（对接-R2b §2.5/§7.1）：贡献号入池即设的全局优先级，cpamp 数字越大越优先 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-1 font-bold text-white">入池优先级</h2>
          <p className="mb-4 text-xs text-neutral-500">
            贡献账号入池时统一设置的优先级，缺省 <code>10</code>，数值越大越优先被调用（号主越先赚分）。非负整数。
          </p>
          <div className="flex items-center gap-2">
            <input
              className={field + ' w-40'}
              type="number"
              min={0}
              value={poolPriority}
              onChange={(e) => setPoolPriority(e.target.value)}
              placeholder="10"
            />
            <button
              onClick={savePool}
              className="rounded-lg bg-[var(--brand)]/20 px-3 py-1.5 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
            >
              保存
            </button>
          </div>
        </section>

        {/* 审计日志（P4-R1，§7.3）：只读倒序。old/new 为脱敏摘要，查看不泄敏感值 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-bold text-white">审计日志</h2>
            <button
              onClick={loadAudit}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs hover:bg-white/10"
            >
              刷新
            </button>
          </div>
          <p className="mb-4 text-xs text-neutral-500">
            配置写操作留痕（操作人 / 时间 / 动作 / 目标 / 旧→新）。最新 50 条，倒序。
          </p>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[130px_130px_1.2fr_1.4fr_2fr] gap-2 text-[11px] text-neutral-500">
              <span>时间</span><span>操作人</span><span>动作</span><span>目标</span><span>旧 → 新</span>
            </div>
            {audit.length === 0 && <p className="py-2 text-xs text-neutral-600">暂无留痕</p>}
            {audit.map((a) => (
              <div
                key={a.id}
                className="grid grid-cols-[130px_130px_1.2fr_1.4fr_2fr] items-start gap-2 border-t border-white/5 py-1.5 text-[11px] text-neutral-300"
              >
                <span className="text-neutral-500">{new Date(a.createdAt).toLocaleString('zh-CN')}</span>
                <span title={a.actorType}>
                  {a.actorLabel}
                  {a.actorId != null && <span className="text-neutral-500"> #{a.actorId}</span>}
                </span>
                <span className="font-mono text-emerald-300/80">{a.action}</span>
                <span className="break-all text-neutral-400">{a.target}</span>
                <span className="break-all text-neutral-400">
                  <span className="text-rose-300/70">{a.oldValue ?? '—'}</span>
                  <span className="text-neutral-600"> → </span>
                  <span className="text-emerald-300/70">{a.newValue ?? '—'}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* 待人工复核（P4-R3，§7.4）：needs_review 号的人工出口。重试→转回首检队列；终止→停用（不删行、不碰结算表） */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-bold text-white">待人工复核</h2>
            <button
              onClick={loadReview}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs hover:bg-white/10"
            >
              刷新
            </button>
          </div>
          <p className="mb-4 text-xs text-neutral-500">
            卡在 <code>needs_review</code> 的号（残缺号 / 首检或巡检需重授权）。<b>重试</b>按是否入过池分叉：
            未入过池→转回首检队列重查；已入过池→直接回池、交由巡检复核（不重走首检，保住历史结算与唯一键）。
            <b>终止</b>放弃并停用（保留记录、不影响已有结算）。
          </p>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[130px_110px_80px_1fr_auto] gap-2 text-[11px] text-neutral-500">
              <span>提交时间</span><span>用户</span><span>provider</span><span>account</span><span>操作</span>
            </div>
            {review.length === 0 && <p className="py-2 text-xs text-neutral-600">暂无待复核</p>}
            {review.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[130px_110px_80px_1fr_auto] items-center gap-2 border-t border-white/5 py-1.5 text-[11px] text-neutral-300"
              >
                <span className="text-neutral-500">{new Date(r.createdAt).toLocaleString('zh-CN')}</span>
                <span>{r.username || <span className="text-neutral-500">#{r.linuxdoId}</span>}</span>
                <span className="text-neutral-400">{r.provider}</span>
                <span className="break-all text-neutral-400">{r.accountId}</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => doReview(r.id, 'retry')}
                    className="rounded-lg bg-[var(--brand)]/20 px-2.5 py-1 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
                  >
                    重试
                  </button>
                  <button
                    onClick={() => doReview(r.id, 'terminate')}
                    className="rounded-lg bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/20"
                  >
                    终止
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 贡献记录（P4-R3，§6.146）：全局倒序只读。脱敏——不含 email/reward_code。积分＝该号累计发分 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-bold text-white">贡献记录</h2>
            <button
              onClick={loadContributions}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs hover:bg-white/10"
            >
              刷新
            </button>
          </div>
          <p className="mb-4 text-xs text-neutral-500">用户贡献的账号（最新 50 条，倒序）。积分＝该号累计发分。</p>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[120px_100px_70px_60px_80px_1fr_56px] gap-2 text-[11px] text-neutral-500">
              <span>时间</span><span>用户</span><span>provider</span><span>套餐</span><span>状态</span><span>account</span><span>积分</span>
            </div>
            {contributions.length === 0 && <p className="py-2 text-xs text-neutral-600">暂无贡献</p>}
            {contributions.map((c) => (
              <div
                key={c.id}
                className="grid grid-cols-[120px_100px_70px_60px_80px_1fr_56px] items-center gap-2 border-t border-white/5 py-1.5 text-[11px] text-neutral-300"
              >
                <span className="text-neutral-500">{new Date(c.createdAt).toLocaleString('zh-CN')}</span>
                <span>{c.username || <span className="text-neutral-500">#{c.linuxdoId}</span>}</span>
                <span className="text-neutral-400">{c.provider}</span>
                <span className="text-neutral-400">{c.plan}</span>
                <span className="font-mono text-neutral-400">{c.verifyStatus}</span>
                <span className="break-all text-neutral-400">{c.accountId}</span>
                <span className="text-emerald-300/80">{c.points}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 每日结算记录（P4-R3，§6.146）：全局倒序只读。用户/归属由 LEFT JOIN 取 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-bold text-white">每日结算记录</h2>
            <button
              onClick={loadSettlements}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs hover:bg-white/10"
            >
              刷新
            </button>
          </div>
          <p className="mb-4 text-xs text-neutral-500">按日折算的结算流水（最新 50 条，倒序）。积分＝round(次数 × 单价)。</p>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[100px_100px_70px_1fr_56px_56px_130px] gap-2 text-[11px] text-neutral-500">
              <span>日期</span><span>用户</span><span>provider</span><span>account</span><span>次数</span><span>积分</span><span>结算时刻</span>
            </div>
            {settlements.length === 0 && <p className="py-2 text-xs text-neutral-600">暂无结算</p>}
            {settlements.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[100px_100px_70px_1fr_56px_56px_130px] items-center gap-2 border-t border-white/5 py-1.5 text-[11px] text-neutral-300"
              >
                <span className="text-neutral-400">{s.date}</span>
                <span>{s.username || <span className="text-neutral-500">#{s.linuxdoId ?? '—'}</span>}</span>
                <span className="text-neutral-400">{s.provider}</span>
                <span className="break-all text-neutral-400">{s.accountId}</span>
                <span className="text-neutral-400">{s.callCount}</span>
                <span className="text-emerald-300/80">{s.points}</span>
                <span className="text-neutral-500">{new Date(s.settledAt).toLocaleString('zh-CN')}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 兑换记录（P4-R3，§6.146）：全局倒序只读。🔴 §8——后端已脱敏，绝不含 result（CDK 码），故无「码」列 */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-bold text-white">兑换记录</h2>
            <button
              onClick={loadRedemptions}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs hover:bg-white/10"
            >
              刷新
            </button>
          </div>
          <p className="mb-4 text-xs text-neutral-500">
            用户兑换流水（最新 50 条，倒序）。安全起见<b>不显示兑换码</b>（码仅号主本人可在前台找回）。
          </p>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[130px_110px_1fr_64px_90px] gap-2 text-[11px] text-neutral-500">
              <span>时间</span><span>用户</span><span>商品</span><span>花费</span><span>状态</span>
            </div>
            {redemptions.length === 0 && <p className="py-2 text-xs text-neutral-600">暂无兑换</p>}
            {redemptions.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[130px_110px_1fr_64px_90px] items-center gap-2 border-t border-white/5 py-1.5 text-[11px] text-neutral-300"
              >
                <span className="text-neutral-500">{new Date(r.createdAt).toLocaleString('zh-CN')}</span>
                <span>{r.username || <span className="text-neutral-500">#{r.linuxdoId}</span>}</span>
                <span className="break-all text-neutral-400">{r.itemName}</span>
                <span className="text-neutral-400">{r.cost}</span>
                <span className="font-mono text-neutral-400">{r.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}

// CDK 库存导入（P4-R1）：选兑换项 + 贴码 + 面额 → POST /api/admin/cdk。选项变更即拉库存概览（GET）。
// ⚠️ 全程绝不接收/展示码本身（§8）：请求发出的是码文本，响应只回 { imported, skipped, available } 计数。
function CdkImport({
  items,
  onDone,
  flash,
}: {
  items: RedeemItem[]
  onDone: () => void
  flash: (t: string) => void
}) {
  const [itemId, setItemId] = useState(0)
  const [codes, setCodes] = useState('')
  const [faceValue, setFaceValue] = useState('')
  const [stats, setStats] = useState<CdkStats | null>(null)

  const selected = items.find((i) => i.id === itemId)
  const isLdc = selected?.kind === 'ldc'

  const loadStats = useCallback(async (id: number) => {
    const d = await fetch('/api/admin/cdk?itemId=' + id, { cache: 'no-store' }).then((r) => r.json())
    setStats(d.ok ? d.stats : null)
  }, [])
  useEffect(() => {
    if (itemId > 0) loadStats(itemId)
    else setStats(null)
  }, [itemId, loadStats])

  async function doImport() {
    if (itemId <= 0) {
      flash('请选择兑换项')
      return
    }
    if (codes.trim() === '') {
      flash('请粘贴要导入的码')
      return
    }
    const body: { itemId: number; codes: string; faceValue?: number } = { itemId, codes }
    // LDC 商品必带正整数面额；非 LDC 若填了也一并传（API 会忽略）。空则不带（交 API 校验/落 null）。
    if (faceValue.trim() !== '') body.faceValue = Number(faceValue)
    const res = await fetch('/api/admin/cdk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const d = await res.json()
    if (res.ok) {
      flash(`导入 ${d.imported}、跳过 ${d.skipped}，当前可用 ${d.available}`)
      setCodes('')
      loadStats(itemId)
      onDone()
    } else flash(d.error || '导入失败')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={field} value={itemId} onChange={(e) => setItemId(Number(e.target.value))}>
          <option value={0}>选择兑换项…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              #{i.id} {i.name}
              {i.kind === 'ldc' ? '（LDC）' : ''}
              {i.fulfillment === 'cdk' ? '' : '（非发码项）'}
            </option>
          ))}
        </select>
        <input
          className={field + ' w-32'}
          type="number"
          min={1}
          value={faceValue}
          onChange={(e) => setFaceValue(e.target.value)}
          placeholder={isLdc ? '面额*（正整数）' : '面额（LDC 用）'}
        />
        <button
          onClick={doImport}
          className="rounded-lg bg-[var(--brand)]/20 px-3 py-1.5 text-xs font-medium text-[var(--brand-bright)] hover:bg-[var(--brand)]/30"
        >
          导入
        </button>
        {stats && (
          <span className="text-xs text-neutral-500">
            库存：可用 <b className="text-emerald-300">{stats.available}</b> / 已发 {stats.issued} / 作废{' '}
            {stats.void}
          </span>
        )}
      </div>
      <textarea
        className={field + ' h-28 w-full font-mono'}
        value={codes}
        onChange={(e) => setCodes(e.target.value)}
        placeholder="一行一码，或用逗号 / 空格分隔"
      />
    </div>
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

// 折算规则一行（P4-R2 §3.4）：仿 RuleRow，唯一差异＝单价输入可小数（step=0.1）。upsert 以 (provider, plan) 为键，不传 id
function RateRow({
  rate,
  onSave,
  onDelete,
  isNew,
}: {
  rate?: UsageRate
  onSave: (r: Partial<UsageRate>) => void
  onDelete?: () => void
  isNew?: boolean
}) {
  const [provider, setProvider] = useState(rate?.provider ?? '')
  const [plan, setPlan] = useState(rate?.plan ?? '')
  const [pointsPerCall, setPointsPerCall] = useState(rate?.pointsPerCall ?? 0)
  const [label, setLabel] = useState(rate?.label ?? '')
  const [enabled, setEnabled] = useState((rate?.enabled ?? 1) !== 0)

  return (
    <div className="grid grid-cols-[1fr_1fr_80px_1.4fr_auto_auto] items-center gap-2">
      {/* 存量行 provider/plan 禁改（P4-R2 codex 复审 P2）：upsert 按 (provider,plan) 键，改键＝插新行、旧行仍
          enabled 计价。改档口径＝先删旧行再新增（唯 isNew 行可编辑键）。置灰样式与信任门槛 disabled 输入一致。 */}
      <input className={field + (isNew ? '' : ' opacity-40')} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="codex" disabled={!isNew} />
      <input className={field + (isNew ? '' : ' opacity-40')} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="plus / *" disabled={!isNew} />
      <input className={field} type="number" step={0.1} min={0} value={pointsPerCall} onChange={(e) => setPointsPerCall(Number(e.target.value))} />
      <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签" />
      <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
      <div className="flex gap-1">
        <button
          onClick={() => onSave({ provider, plan, pointsPerCall, label, enabled: enabled ? 1 : 0 })}
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
