/* Hallmark · macrostructure: Workbench · genre: atmospheric · theme: homepage-inherited
 * tone: technical · anchor hue: OpenAI green · enrichment: none · nav: N3 side rail · footer: none
 * contrast: pass (40–41) · mobile: pass (34, 49–56) · honest: pass (46) · chrome: pass (47)
 */
/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog, { type ConfirmDialogRequest } from './ConfirmDialog'
import { OpenAIMark } from '@/components/OpenAIMark'
import StarField from '@/components/StarField'
import NebulaBackground from '@/components/NebulaBackground'
import {
  loadingServiceProbe,
  probeSystemStatus,
  type ServiceProbeResult,
} from '@/lib/service-status'
import {
  parseAdminRedeemItemsResponse,
  type AdminOverviewResponse,
  type AdminRedeemItem,
} from '@/lib/admin-redeem-items-response'

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
type RedeemItem = AdminRedeemItem
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
type AdminOverview = AdminOverviewResponse
interface PendingConfirmation extends ConfirmDialogRequest {
  run: () => Promise<void>
  fallbackFocus: () => HTMLElement | null
}

const PUBLIC_DELETE_ERRORS = {
  pointRule: '删除发分规则失败，请重试',
  usageRate: '删除折算规则失败，请重试',
  redeemItem: '删除兑换项失败，请重试',
  review: '人工复核操作失败，请重试',
} as const

const PUBLIC_REDEEM_ITEM_SAVE_ERROR = '保存兑换项失败，请重试'
const PUBLIC_ADMIN_LOAD_ERROR = '部分后台数据暂时无法加载，请刷新重试'
const PUBLIC_AUDIT_LOAD_ERROR = '审计记录暂时无法加载，请重试'
const PUBLIC_REDEEM_ITEM_SAVE_ERRORS_BY_CODE: Record<string, string> = {
  REDEEM_ITEM_SAVE_FAILED: PUBLIC_REDEEM_ITEM_SAVE_ERROR,
  REDEEM_ITEM_NOT_FOUND: '兑换项不存在或已被删除，请刷新后重试',
  IDEMPOTENCY_KEY_CONFLICT: '该新增请求与已提交内容不一致，请重新编辑后再试',
}

const PUBLIC_ACTION_ERRORS_BY_CODE = {
  POINT_RULE_DELETE_FAILED: PUBLIC_DELETE_ERRORS.pointRule,
  USAGE_RATE_DELETE_FAILED: PUBLIC_DELETE_ERRORS.usageRate,
  REDEEM_ITEM_DELETE_FAILED: PUBLIC_DELETE_ERRORS.redeemItem,
  REDEEM_ITEM_SAVE_FAILED: PUBLIC_REDEEM_ITEM_SAVE_ERROR,
  REVIEW_ACTION_FAILED: PUBLIC_DELETE_ERRORS.review,
} as const

function publicActionError(code: unknown, expectedCode: keyof typeof PUBLIC_ACTION_ERRORS_BY_CODE, fallback: string) {
  if (code !== expectedCode) return fallback
  return PUBLIC_ACTION_ERRORS_BY_CODE[expectedCode]
}

function publicRedeemItemSaveError(code: unknown): string {
  return typeof code === 'string'
    ? PUBLIC_REDEEM_ITEM_SAVE_ERRORS_BY_CODE[code] ?? PUBLIC_REDEEM_ITEM_SAVE_ERROR
    : PUBLIC_REDEEM_ITEM_SAVE_ERROR
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

const ADMIN_NAV = [
  { href: '#overview', label: '运营概览' },
  { href: '#rules', label: '积分规则' },
  { href: '#store', label: '商店与库存' },
  { href: '#runtime', label: '运行参数' },
  { href: '#audit', label: '审计日志' },
  { href: '#review', label: '人工复核' },
  { href: '#data', label: '数据记录' },
] as const

const field =
  'min-h-11 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:bg-white/[0.07] focus-visible:border-emerald-400/50 focus-visible:ring-2 focus-visible:ring-emerald-400/30 disabled:cursor-not-allowed disabled:opacity-50'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0
}

function isPointRule(value: unknown): value is PointRule {
  return isRecord(value) && isSafeInteger(value.id) && value.id > 0 &&
    typeof value.provider === 'string' && typeof value.plan === 'string' &&
    isSafeInteger(value.points) && (value.enabled === 0 || value.enabled === 1) &&
    typeof value.label === 'string'
}

function isUsageRate(value: unknown): value is UsageRate {
  return isRecord(value) && isSafeInteger(value.id) && value.id > 0 &&
    typeof value.provider === 'string' && typeof value.plan === 'string' &&
    typeof value.pointsPerCall === 'number' && Number.isFinite(value.pointsPerCall) && value.pointsPerCall >= 0 &&
    (value.enabled === 0 || value.enabled === 1) && typeof value.label === 'string'
}

function isContributionRow(value: unknown): value is ContributionRow {
  return isRecord(value) && typeof value.id === 'string' && isSafeInteger(value.linuxdoId) && value.linuxdoId > 0 &&
    typeof value.username === 'string' && typeof value.provider === 'string' && typeof value.plan === 'string' &&
    typeof value.accountId === 'string' && typeof value.verifyStatus === 'string' &&
    isNonNegativeSafeInteger(value.points) && isNonNegativeSafeInteger(value.createdAt)
}

function isSettlementRow(value: unknown): value is SettlementRow {
  return isRecord(value) && isSafeInteger(value.id) && value.id > 0 &&
    typeof value.contributionId === 'string' &&
    (value.linuxdoId === null || (isSafeInteger(value.linuxdoId) && value.linuxdoId > 0)) &&
    typeof value.username === 'string' && typeof value.date === 'string' &&
    typeof value.provider === 'string' && typeof value.accountId === 'string' &&
    isNonNegativeSafeInteger(value.callCount) && isSafeInteger(value.points) &&
    isNonNegativeSafeInteger(value.settledAt)
}

function isRedemptionRow(value: unknown): value is RedemptionRow {
  return isRecord(value) && typeof value.id === 'string' && isSafeInteger(value.linuxdoId) && value.linuxdoId > 0 &&
    typeof value.username === 'string' && typeof value.itemName === 'string' &&
    isNonNegativeSafeInteger(value.cost) && typeof value.status === 'string' &&
    isNonNegativeSafeInteger(value.createdAt)
}

function isReviewRow(value: unknown): value is ReviewRow {
  return isRecord(value) && typeof value.id === 'string' && isSafeInteger(value.linuxdoId) && value.linuxdoId > 0 &&
    typeof value.username === 'string' && typeof value.provider === 'string' &&
    typeof value.accountId === 'string' && isNonNegativeSafeInteger(value.createdAt) &&
    isNonNegativeSafeInteger(value.updatedAt)
}

function isAuditRow(value: unknown): value is AuditRow {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 &&
    typeof value.actorType === 'string' &&
    (value.actorId === null || (typeof value.actorId === 'number' && Number.isSafeInteger(value.actorId))) &&
    typeof value.actorLabel === 'string' &&
    typeof value.action === 'string' &&
    typeof value.target === 'string' &&
    (value.oldValue === null || typeof value.oldValue === 'string') &&
    (value.newValue === null || typeof value.newValue === 'string') &&
    typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
  )
}

async function fetchAdminObject(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-store' })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('invalid admin response')
  }
  if (!response.ok || !isRecord(body)) throw new Error('admin request failed')
  return body
}

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
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [systemStatus, setSystemStatus] = useState<{
    liveness: ServiceProbeResult
    readiness: ServiceProbeResult
  }>({ liveness: loadingServiceProbe(), readiness: loadingServiceProbe() })
  const [refreshingStatus, setRefreshingStatus] = useState(false)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const statusRefreshInFlight = useRef(false)
  const ruleHeadingRef = useRef<HTMLHeadingElement>(null)
  const rateHeadingRef = useRef<HTMLHeadingElement>(null)
  const itemHeadingRef = useRef<HTMLHeadingElement>(null)
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null)
  const [msg, setMsg] = useState('')
  const [itemError, setItemError] = useState('')
  const [auditError, setAuditError] = useState('')
  const [adminLoadError, setAdminLoadError] = useState('')
  const savingItemKeysRef = useRef(new Set<string>())
  const [savingItemKeys, setSavingItemKeys] = useState<Set<string>>(() => new Set())

  const load = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/config')
      if (!Array.isArray(d.pointRules) || !d.pointRules.every(isPointRule)) throw new Error('invalid point rules')
      const parsed = parseAdminRedeemItemsResponse({
        ok: true,
        redeemItems: d.redeemItems,
        overview: d.overview,
      })
      if (!parsed) throw new Error('invalid redeem item config')
      setRules(d.pointRules)
      setItems(parsed.redeemItems)
      setOverview(parsed.overview)
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadRates = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/usage-rates')
      if (d.ok !== true || !Array.isArray(d.usageRates) || !d.usageRates.every(isUsageRate)) throw new Error('invalid usage rates')
      setRates(d.usageRates)
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadQuota = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/ldc-quota')
      if (d.ok !== true || typeof d.quota !== 'number' || !Number.isSafeInteger(d.quota) || d.quota < 0) {
        throw new Error('invalid quota')
      }
      setQuota(String(d.quota))
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadGate = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/trust-gate')
      if (
        d.ok !== true || typeof d.enabled !== 'boolean' || typeof d.minTrust !== 'number' ||
        !Number.isSafeInteger(d.minTrust) || d.minTrust < 0
      ) throw new Error('invalid trust gate')
      setGateEnabled(d.enabled)
      setMinTrust(String(d.minTrust))
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadSettle = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/settle-params')
      if (
        d.ok !== true || typeof d.graceMinutes !== 'number' || !Number.isSafeInteger(d.graceMinutes) ||
        d.graceMinutes < 0 || d.graceMinutes > 1439
      ) throw new Error('invalid settle params')
      setGraceMinutes(String(d.graceMinutes))
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadPool = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/pool-priority')
      if (
        d.ok !== true || typeof d.poolPriority !== 'number' || !Number.isSafeInteger(d.poolPriority) ||
        d.poolPriority < 0
      ) throw new Error('invalid pool priority')
      setPoolPriority(String(d.poolPriority))
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadAudit = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/audit?limit=50')
      if (d.ok !== true || !Array.isArray(d.audit) || !d.audit.every(isAuditRow)) {
        throw new Error('invalid audit')
      }
      setAudit(d.audit)
      setAuditError('')
    } catch {
      setAuditError(PUBLIC_AUDIT_LOAD_ERROR)
    }
  }, [])
  // 数据查看三块：各拉一页（limit=50）。§8——兑换记录后端已脱敏，不含 result
  const loadContributions = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/contributions?limit=50')
      if (d.ok !== true || !Array.isArray(d.contributions) || !d.contributions.every(isContributionRow)) throw new Error('invalid contributions')
      setContributions(d.contributions)
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadSettlements = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/settlements?limit=50')
      if (d.ok !== true || !Array.isArray(d.settlements) || !d.settlements.every(isSettlementRow)) throw new Error('invalid settlements')
      setSettlements(d.settlements)
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadRedemptions = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/redemptions?limit=50')
      if (d.ok !== true || !Array.isArray(d.redemptions) || !d.redemptions.every(isRedemptionRow)) throw new Error('invalid redemptions')
      setRedemptions(d.redemptions)
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const loadReview = useCallback(async () => {
    try {
      const d = await fetchAdminObject('/api/admin/review')
      if (d.ok !== true || !Array.isArray(d.review) || !d.review.every(isReviewRow)) throw new Error('invalid review')
      setReview(d.review)
    } catch {
      setAdminLoadError(PUBLIC_ADMIN_LOAD_ERROR)
    }
  }, [])
  const refreshSystemStatus = useCallback(async () => {
    if (statusRefreshInFlight.current) return
    statusRefreshInFlight.current = true
    setRefreshingStatus(true)
    setSystemStatus({ liveness: loadingServiceProbe(), readiness: loadingServiceProbe() })
    try {
      setSystemStatus(await probeSystemStatus())
    } finally {
      statusRefreshInFlight.current = false
      setRefreshingStatus(false)
    }
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
    refreshSystemStatus()
  }, [
    load, loadRates, loadQuota, loadGate, loadSettle, loadPool, loadAudit,
    loadContributions, loadSettlements, loadRedemptions, loadReview, refreshSystemStatus,
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
    const res = await fetch('/api/admin/point-rules?id=' + id, { method: 'DELETE' })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || !d.ok || !Array.isArray(d.pointRules)) {
      throw new Error(publicActionError(d.code, 'POINT_RULE_DELETE_FAILED', PUBLIC_DELETE_ERRORS.pointRule))
    }
    setRules(d.pointRules)
    flash('已删除')
    void loadAudit().catch(() => {})
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
    const res = await fetch('/api/admin/usage-rates?id=' + id, { method: 'DELETE' })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || !d.ok || !Array.isArray(d.usageRates)) {
      throw new Error(publicActionError(d.code, 'USAGE_RATE_DELETE_FAILED', PUBLIC_DELETE_ERRORS.usageRate))
    }
    setRates(d.usageRates)
    flash('已删除')
    void loadAudit().catch(() => {})
  }
  async function saveItem(
    it: Partial<RedeemItem>,
    rowKey: string,
    idempotencyKey?: string,
  ): Promise<boolean> {
    if (savingItemKeysRef.current.has(rowKey)) return false
    savingItemKeysRef.current.add(rowKey)
    setSavingItemKeys(new Set(savingItemKeysRef.current))
    setItemError('')
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
      const res = await fetch('/api/admin/redeem-items', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...it, enabled: it.enabled !== 0 }),
      })
      const d = await res.json().catch(() => null)
      const parsed = parseAdminRedeemItemsResponse(d)
      if (!res.ok || !parsed) {
        setItemError(publicRedeemItemSaveError(isRecord(d) ? d.code : undefined))
        return false
      }
      setItems(parsed.redeemItems)
      setOverview(parsed.overview)
      flash('已保存')
      void loadAudit()
      return true
    } catch {
      setItemError(PUBLIC_REDEEM_ITEM_SAVE_ERROR)
      return false
    } finally {
      savingItemKeysRef.current.delete(rowKey)
      setSavingItemKeys(new Set(savingItemKeysRef.current))
    }
  }
  async function delItem(id: number) {
    const res = await fetch('/api/admin/redeem-items?id=' + id, { method: 'DELETE' })
    const d = await res.json().catch(() => null)
    const parsed = parseAdminRedeemItemsResponse(d)
    if (!res.ok || !parsed) {
      throw new Error(publicActionError(isRecord(d) ? d.code : undefined, 'REDEEM_ITEM_DELETE_FAILED', PUBLIC_DELETE_ERRORS.redeemItem))
    }
    setItems(parsed.redeemItems)
    setOverview(parsed.overview)
    flash('已删除')
    void loadAudit().catch(() => {})
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
    const d = await res.json().catch(() => ({}))
    if (res.ok && d.ok) {
      setReview(d.review ?? [])
      flash(action === 'retry' ? '已重试' : '已终止')
      void loadAudit().catch(() => {})
      void loadContributions().catch(() => {})
      void load().catch(() => {})
    } else throw new Error(publicActionError(d.code, 'REVIEW_ACTION_FAILED', PUBLIC_DELETE_ERRORS.review))
  }

  function confirmRuleDelete(rule: PointRule) {
    setConfirmation({
      title: '确认删除发分规则',
      target: `${rule.provider} / ${rule.plan}`,
      consequence: '删除后该规则立即停止发分；如需恢复，必须重新创建并保存。',
      confirmLabel: '确认删除',
      run: () => delRule(rule.id),
      fallbackFocus: () => ruleHeadingRef.current,
    })
  }

  function confirmRateDelete(rate: UsageRate) {
    setConfirmation({
      title: '确认删除折算规则',
      target: `${rate.provider} / ${rate.plan}`,
      consequence: '删除后该套餐将不再按此单价结算；如无兜底规则，后续用量可能不再发分。',
      confirmLabel: '确认删除',
      run: () => delRate(rate.id),
      fallbackFocus: () => rateHeadingRef.current,
    })
  }

  function confirmItemDelete(item: RedeemItem) {
    setConfirmation({
      title: '确认删除兑换项',
      target: item.name,
      consequence: '该商品会从商店配置中删除；历史兑换记录仍保留，但此操作不能在当前页面撤销。',
      confirmLabel: '确认删除',
      run: () => delItem(item.id),
      fallbackFocus: () => itemHeadingRef.current,
    })
  }

  function confirmReviewAction(row: ReviewRow, action: 'retry' | 'terminate') {
    const retry = action === 'retry'
    setConfirmation({
      title: retry ? '确认重试人工复核' : '确认终止人工复核',
      target: `${row.provider} / ${row.accountId}`,
      consequence: retry
        ? '该账号会按既有状态机重新进入首检或直接回池；已有结算与唯一键语义不变。'
        : '该账号会被标记为已停用并退出待复核队列；历史记录与已有结算会保留。',
      confirmLabel: retry ? '确认重试' : '确认终止',
      run: () => doReview(row.id, action),
      fallbackFocus: () => reviewHeadingRef.current,
    })
  }

  const lastCheckedAt = Math.max(
    systemStatus.liveness.checkedAt ?? 0,
    systemStatus.readiness.checkedAt ?? 0,
  )

  return (
    <main id="admin-top" className="bg-ink relative min-h-[100dvh] min-w-0 overflow-x-clip text-neutral-200">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <NebulaBackground />
        <StarField />
        <div className="bg-grid absolute inset-0" />
        <div className="absolute inset-0 bg-neutral-950/55" />
      </div>

      <div className="relative mx-auto min-w-0 max-w-[90rem] px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <header className="mb-6 flex min-w-0 flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-[var(--ink-soft)]">
              <OpenAIMark className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0 leading-tight">
              <h1 className="text-xl font-bold tracking-tight text-white">管理后台</h1>
              <p className="mono mt-1 truncate text-[10px] uppercase tracking-[0.16em] text-[var(--brand-bright)]">
                OpenAI Plus 收集系统 · 小鸡毛の公益宇宙
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
            {msg && (
              <span role="status" aria-live="polite" className="min-w-0 break-words px-1 text-xs text-emerald-300">
                {msg}
              </span>
            )}
            <a
              href="/dashboard"
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 text-sm text-neutral-300 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              返回前台
            </a>
            <a
              href="/api/admin/logout"
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-neutral-200 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              退出
            </a>
          </div>
        </header>

        {adminLoadError && (
          <p role="alert" className="mb-6 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            {adminLoadError}
          </p>
        )}

        <div className="grid min-w-0 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="min-w-0 lg:row-span-full">
            <nav
              aria-label="后台分区"
              className="sticky top-2 z-20 -mx-1 overflow-x-auto rounded-xl border border-white/10 bg-neutral-950/90 p-1.5 shadow-sm shadow-black/20 backdrop-blur-xl lg:top-6 lg:mx-0 lg:overflow-visible lg:rounded-2xl lg:p-2"
            >
              <div className="flex min-w-max gap-1 lg:min-w-0 lg:flex-col">
                {ADMIN_NAV.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="group inline-flex min-h-10 items-center justify-between gap-3 whitespace-nowrap rounded-lg px-3 text-sm text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 lg:w-full"
                  >
                    <span>{item.label}</span>
                    {item.href === '#review' && (overview?.needsReview ?? 0) > 0 && (
                      <span className="mono rounded-full border border-amber-300/20 bg-amber-300/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                        {overview?.needsReview}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            </nav>
          </aside>

          <div className="min-w-0 space-y-8 lg:space-y-10">

        <section id="overview" aria-labelledby="admin-overview-title" className="scroll-mt-24 min-w-0 rounded-3xl border border-white/10 bg-white/[0.04] p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl">
              <h2 id="admin-overview-title" className="text-lg font-bold tracking-tight text-white">运营概览</h2>
              <p className="mt-1 text-sm leading-6 text-neutral-400">真实数据库总数与当前服务探针；Liveness 和 Readiness 分别检查。</p>
            </div>
            <button
              type="button"
              data-testid="refresh-system-status"
              onClick={refreshSystemStatus}
              disabled={refreshingStatus}
              className="inline-flex min-h-11 items-center justify-center self-start whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-medium text-neutral-200 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshingStatus ? '检查中…' : '刷新系统状态'}
            </button>
          </div>

          <dl className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl border border-white/10 bg-black/15 sm:grid-cols-4">
            {[
              ['在池账号', overview?.pooledAccounts],
              ['待人工复核', overview?.needsReview],
              ['待处理兑换', overview?.pendingRedemptions],
              ['已启用商品', overview?.enabledRedeemItems],
            ].map(([label, value], index) => (
              <div
                key={String(label)}
                className={`px-4 py-4 ${index % 2 === 1 ? 'border-l border-white/10' : ''} ${index >= 2 ? 'border-t border-white/10 sm:border-t-0' : ''} ${index > 0 ? 'sm:border-l sm:border-white/10' : ''}`}
              >
                <dt className="text-xs text-neutral-400">{label}</dt>
                <dd className="mono mt-1 text-2xl font-bold tabular-nums text-white">{value ?? '—'}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <ServiceStatusCard
              testId="liveness-status"
              title="Liveness"
              subtitle="进程存活 / 可响应"
              result={systemStatus.liveness}
            />
            <ServiceStatusCard
              testId="readiness-status"
              title="Readiness"
              subtitle="本地 SQLite / Schema / 写入"
              result={systemStatus.readiness}
            />
          </div>
          <p className="mt-3 text-right text-[11px] text-neutral-500">
            {lastCheckedAt > 0
              ? `最近检查：${new Date(lastCheckedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
              : '最近检查：尚未完成'}
          </p>
        </section>

        <div id="rules" className="scroll-mt-24 min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
        {/* 发分规则 */}
        <section className="min-w-0 p-5 sm:p-6">
          <h2 ref={ruleHeadingRef} tabIndex={-1} className="mb-1 text-lg font-bold tracking-tight text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">发分规则</h2>
          <p className="mb-5 max-w-4xl text-sm leading-6 text-neutral-400">
            账号验证通过后，按 (provider, 套餐) 发放积分。plan 填 <code>*</code> 作为该 provider 的兜底。改完点保存即时生效。
          </p>
          <div className="space-y-3">
            <div className="hidden grid-cols-[minmax(7rem,1fr)_minmax(7rem,1fr)_6rem_minmax(10rem,1.4fr)_3rem_auto] gap-2 px-1 text-[11px] text-neutral-400 xl:grid">
              <span>provider</span><span>plan</span><span>积分</span><span>标签</span><span>启用</span><span></span>
            </div>
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} onSave={saveRule} onDelete={() => confirmRuleDelete(r)} />
            ))}
            <RuleRow onSave={saveRule} isNew />
          </div>
        </section>

        {/* 折算规则（按次单价，P4-R2 §3.4）：按 (provider, 套餐) 每次调用积分单价，可小数。plan 填 * 作兜底 */}
        <section className="min-w-0 border-t border-white/10 p-5 sm:p-6">
          <h2 ref={rateHeadingRef} tabIndex={-1} className="mb-1 text-lg font-bold tracking-tight text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">折算规则（按次单价）</h2>
          <p className="mb-5 max-w-4xl text-sm leading-6 text-neutral-400">
            号在池后，按 cpamp 每日调用量折算积分：结算 = round(次数 × 单价)。单价可小数（如 <code>0.5</code>）。plan 填{' '}
            <code>*</code> 作该 provider 的兜底。改完点保存即时生效。改 <code>provider</code>/<code>plan</code> 需先删旧行再新增。
          </p>
          <div className="space-y-3">
            <div className="hidden grid-cols-[minmax(7rem,1fr)_minmax(7rem,1fr)_6rem_minmax(10rem,1.4fr)_3rem_auto] gap-2 px-1 text-[11px] text-neutral-400 xl:grid">
              <span>provider</span><span>plan</span><span>单价</span><span>标签</span><span>启用</span><span></span>
            </div>
            {rates.map((r) => (
              <RateRow key={r.id} rate={r} onSave={saveRate} onDelete={() => confirmRateDelete(r)} />
            ))}
            <RateRow onSave={saveRate} isNew />
          </div>
        </section>
        </div>

        <div id="store" className="scroll-mt-24 min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
        {/* 兑换项 */}
        <section className="min-w-0 p-5 sm:p-6">
          <h2 ref={itemHeadingRef} tabIndex={-1} className="mb-1 text-lg font-bold tracking-tight text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">兑换项（商店）</h2>
          <p className="mb-5 text-sm leading-6 text-neutral-400">用户用积分兑换。履约接口后续接小鸡毛，现为占位。</p>
          {itemError && (
            <p
              data-testid="redeem-item-error"
              role="alert"
              aria-live="assertive"
              className="mb-4 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
            >
              {itemError}
            </p>
          )}
          <div className="space-y-3">
            <div className="hidden grid-cols-[minmax(8rem,1.2fr)_5rem_minmax(8rem,1fr)_minmax(7rem,1fr)_4.5rem_minmax(9rem,1.2fr)_3rem_auto] gap-2 px-1 text-[11px] text-neutral-400 xl:grid">
              <span>名称</span><span>积分价</span><span>类型</span><span>履约</span><span>限购</span><span>说明</span><span>启用</span><span></span>
            </div>
            {items.map((it) => (
              <ItemRow
                key={it.id}
                item={it}
                onSave={saveItem}
                onDelete={() => confirmItemDelete(it)}
                saving={savingItemKeys.has(`item:${it.id}`)}
              />
            ))}
            <ItemRow onSave={saveItem} isNew saving={savingItemKeys.has('new')} />
          </div>
        </section>

        {/* CDK 库存导入（P4-R1）：选项 + 贴码 + 面额 → 导入；只回计数/库存，绝不回显已导入的码 */}
        <section className="min-w-0 border-t border-white/10 p-5 sm:p-6">
          <h2 className="mb-1 text-lg font-bold tracking-tight text-white">CDK 库存导入</h2>
          <p className="mb-5 max-w-4xl text-sm leading-6 text-neutral-400">
            给「CDK 发码」履约的兑换项预导入码（一行一码 / 逗号 / 空白分隔，跨批自动去重）。
            <span className="text-amber-300/80">LDC 商品必填正整数面额（一批同面额）。</span>
            安全起见，导入后只显示计数与库存，<b>不回显任何码</b>。
          </p>
          <CdkImport items={items} onDone={loadAudit} flash={flash} />
        </section>
        </div>

        <div id="runtime" className="scroll-mt-24 grid min-w-0 gap-4 xl:grid-cols-2">
        {/* LDC 每日额度（P4-R1）：读改 app_config['ldc_daily_quota']，缺省 2000 */}
        <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
          <h2 className="mb-1 text-base font-bold tracking-tight text-white">LDC 每日额度</h2>
          <p className="mb-5 flex-1 text-sm leading-6 text-neutral-400">
            当日已发 LDC 面额之和的上限（按服务器本地自然日重置）。0＝当日停发。非负整数。
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              className={field + ' min-w-0 w-full sm:w-40'}
              type="number"
              min={0}
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              placeholder="2000"
              aria-label="LDC 每日额度"
            />
            <button
              onClick={saveQuota}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-4 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              保存
            </button>
          </div>
        </section>

        {/* 信任等级门槛 & 限身份开关（P4-R2 §1）：关＝登录即可、不限等级；开则等级不足拒登录（不使已登录会话失效） */}
        <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
          <h2 className="mb-1 text-base font-bold tracking-tight text-white">信任等级门槛</h2>
          <p className="mb-5 flex-1 text-sm leading-6 text-neutral-400">
            控制谁能登录贡献账号。关闭门槛＝登录即可、不限信任等级；开启则 linux.do 信任等级低于门槛者被拒。
            调整只影响此后登录，不使已登录会话失效。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={gateEnabled}
                onChange={(e) => setGateEnabled(e.target.checked)}
                className="h-4 w-4 accent-emerald-500"
              />
              {gateEnabled ? '限信任等级' : '登录即可（不限）'}
            </label>
            <input
              className={field + ' min-w-0 w-full sm:w-40' + (gateEnabled ? '' : ' opacity-40')}
              type="number"
              min={0}
              value={minTrust}
              onChange={(e) => setMinTrust(e.target.value)}
              disabled={!gateEnabled}
              placeholder="门槛等级，如 1"
              aria-label="最低信任等级"
            />
            <button
              onClick={saveGate}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-4 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              保存
            </button>
          </div>
        </section>

        {/* 结算参数（P4-R2 §3.3）：结算时刻＝午夜后延迟分钟数，缺省 10（00:10）。时区随服务器不可配 */}
        <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
          <h2 className="mb-1 text-base font-bold tracking-tight text-white">结算参数</h2>
          <p className="mb-5 flex-1 text-sm leading-6 text-neutral-400">
            每日结算前一自然日的用量。结算时刻＝午夜后延迟多少分钟再结（吸收迟到落账），缺省 <code>10</code>（即 00:10）。
            范围 0–1439 分钟。<span className="text-amber-300/80">时区随服务器，不可配。</span>
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              className={field + ' min-w-0 w-full sm:w-40'}
              type="number"
              min={0}
              max={1439}
              value={graceMinutes}
              onChange={(e) => setGraceMinutes(e.target.value)}
              placeholder="10"
              aria-label="结算延迟分钟数"
            />
            <span className="text-xs text-neutral-500">分钟（午夜后）</span>
            <button
              onClick={saveSettle}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-4 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              保存
            </button>
          </div>
        </section>

        {/* 入池优先级（对接-R2b §2.5/§7.1）：贡献号入池即设的全局优先级，cpamp 数字越大越优先 */}
        <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
          <h2 className="mb-1 text-base font-bold tracking-tight text-white">入池优先级</h2>
          <p className="mb-5 flex-1 text-sm leading-6 text-neutral-400">
            贡献账号入池时统一设置的优先级，缺省 <code>10</code>，数值越大越优先被调用（号主越先赚分）。非负整数。
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              className={field + ' min-w-0 w-full sm:w-40'}
              type="number"
              min={0}
              value={poolPriority}
              onChange={(e) => setPoolPriority(e.target.value)}
              placeholder="10"
              aria-label="入池优先级"
            />
            <button
              onClick={savePool}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-4 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              保存
            </button>
          </div>
        </section>
        </div>

        {/* 审计日志（P4-R1，§7.3）：只读倒序。old/new 为脱敏摘要，查看不泄敏感值 */}
        <section id="audit" className="scroll-mt-24 min-w-0 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold tracking-tight text-white">审计日志</h2>
            <button
              type="button"
              data-testid="refresh-audit"
              onClick={loadAudit}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 text-xs transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              刷新
            </button>
          </div>
          <p className="mb-5 text-sm leading-6 text-neutral-400">
            配置写操作留痕（操作人 / 时间 / 动作 / 目标 / 旧→新）。最新 50 条，倒序。
          </p>
          {auditError && (
            <p
              data-testid="audit-load-error"
              role="alert"
              className="mb-4 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
            >
              {auditError}
            </p>
          )}
          <div data-testid="audit-table-scroll" className="max-w-full overflow-x-auto rounded-xl border border-white/[0.07] bg-black/15 p-3">
            <div className="min-w-[760px] space-y-1.5 tabular-nums">
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
          </div>
        </section>

        {/* 待人工复核（P4-R3，§7.4）：needs_review 号的人工出口。重试→转回首检队列；终止→停用（不删行、不碰结算表） */}
        <section id="review" className="scroll-mt-24 min-w-0 rounded-2xl border border-amber-300/15 bg-amber-300/[0.025] p-5 sm:p-6">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
            <h2 ref={reviewHeadingRef} tabIndex={-1} className="text-lg font-bold tracking-tight text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">待人工复核</h2>
            <button
              onClick={loadReview}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 text-xs transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              刷新
            </button>
          </div>
          <p className="mb-5 max-w-5xl text-sm leading-6 text-neutral-400">
            卡在 <code>needs_review</code> 的号（残缺号 / 首检或巡检需重授权）。<b>重试</b>按是否入过池分叉：
            未入过池→转回首检队列重查；已入过池→直接回池、交由巡检复核（不重走首检，保住历史结算与唯一键）。
            <b>终止</b>放弃并停用（保留记录、不影响已有结算）。
          </p>
          <div data-testid="review-table-scroll" className="max-w-full overflow-x-auto rounded-xl border border-white/[0.07] bg-black/15 p-3">
            <div className="min-w-[620px] space-y-1.5 tabular-nums">
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
                <span className="min-w-0 break-all [overflow-wrap:anywhere]">
                  {r.username || <span className="text-neutral-500">#{r.linuxdoId}</span>}
                </span>
                <span className="text-neutral-400">{r.provider}</span>
                <span className="break-all text-neutral-400">{r.accountId}</span>
                <div className="flex min-w-max gap-1">
                  <button
                    type="button"
                    onClick={() => confirmReviewAction(r, 'retry')}
                    aria-label={`重试人工复核 ${r.provider} ${r.accountId}`}
                    className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-3 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={() => confirmReviewAction(r, 'terminate')}
                    aria-label={`终止人工复核 ${r.provider} ${r.accountId}`}
                    className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg bg-rose-500/10 px-3 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                  >
                    终止
                  </button>
                </div>
              </div>
              ))}
            </div>
          </div>
        </section>

        <div id="data" className="scroll-mt-24 min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
        {/* 贡献记录（P4-R3，§6.146）：全局倒序只读。脱敏——不含 email/reward_code。积分＝该号累计发分 */}
        <section className="min-w-0 p-5 sm:p-6">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold tracking-tight text-white">贡献记录</h2>
            <button
              onClick={loadContributions}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 text-xs transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              刷新
            </button>
          </div>
          <p className="mb-5 text-sm leading-6 text-neutral-400">用户贡献的账号（最新 50 条，倒序）。积分＝该号累计发分。</p>
          <div data-testid="contributions-table-scroll" className="max-w-full overflow-x-auto rounded-xl border border-white/[0.07] bg-black/15 p-3">
            <div className="min-w-[760px] space-y-1.5 tabular-nums">
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
                <span className="min-w-0 break-all [overflow-wrap:anywhere]">
                  {c.username || <span className="text-neutral-500">#{c.linuxdoId}</span>}
                </span>
                <span className="text-neutral-400">{c.provider}</span>
                <span className="text-neutral-400">{c.plan}</span>
                <span className="font-mono text-neutral-400">{c.verifyStatus}</span>
                <span className="break-all text-neutral-400">{c.accountId}</span>
                <span className="text-emerald-300/80">{c.points}</span>
              </div>
              ))}
            </div>
          </div>
        </section>

        {/* 每日结算记录（P4-R3，§6.146）：全局倒序只读。用户/归属由 LEFT JOIN 取 */}
        <section className="min-w-0 border-t border-white/10 p-5 sm:p-6">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold tracking-tight text-white">每日结算记录</h2>
            <button
              onClick={loadSettlements}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 text-xs transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              刷新
            </button>
          </div>
          <p className="mb-5 text-sm leading-6 text-neutral-400">按日折算的结算流水（最新 50 条，倒序）。积分＝round(次数 × 单价)。</p>
          <div data-testid="settlements-table-scroll" className="max-w-full overflow-x-auto rounded-xl border border-white/[0.07] bg-black/15 p-3">
            <div className="min-w-[780px] space-y-1.5 tabular-nums">
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
                <span className="min-w-0 break-all [overflow-wrap:anywhere]">
                  {s.username || <span className="text-neutral-500">#{s.linuxdoId ?? '—'}</span>}
                </span>
                <span className="text-neutral-400">{s.provider}</span>
                <span className="break-all text-neutral-400">{s.accountId}</span>
                <span className="text-neutral-400">{s.callCount}</span>
                <span className="text-emerald-300/80">{s.points}</span>
                <span className="text-neutral-500">{new Date(s.settledAt).toLocaleString('zh-CN')}</span>
              </div>
              ))}
            </div>
          </div>
        </section>

        {/* 兑换记录（P4-R3，§6.146）：全局倒序只读。🔴 §8——后端已脱敏，绝不含 result（CDK 码），故无「码」列 */}
        <section className="min-w-0 border-t border-white/10 p-5 sm:p-6">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold tracking-tight text-white">兑换记录</h2>
            <button
              onClick={loadRedemptions}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 text-xs transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              刷新
            </button>
          </div>
          <p className="mb-5 text-sm leading-6 text-neutral-400">
            用户兑换流水（最新 50 条，倒序）。安全起见<b>不显示兑换码</b>（码仅号主本人可在前台找回）。
          </p>
          <div data-testid="redemptions-table-scroll" className="max-w-full overflow-x-auto rounded-xl border border-white/[0.07] bg-black/15 p-3">
            <div className="min-w-[560px] space-y-1.5 tabular-nums">
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
                <span className="min-w-0 break-all [overflow-wrap:anywhere]">
                  {r.username || <span className="text-neutral-500">#{r.linuxdoId}</span>}
                </span>
                <span className="break-all text-neutral-400">{r.itemName}</span>
                <span className="text-neutral-400">{r.cost}</span>
                <span className="font-mono text-neutral-400">{r.status}</span>
              </div>
              ))}
            </div>
          </div>
        </section>
        </div>
          </div>
        </div>
      </div>
      {confirmation && (
        <ConfirmDialog
          request={confirmation}
          onClose={() => setConfirmation(null)}
          onConfirm={confirmation.run}
          fallbackFocus={confirmation.fallbackFocus}
        />
      )}
    </main>
  )
}

function ServiceStatusCard({
  testId,
  title,
  subtitle,
  result,
}: {
  testId: string
  title: string
  subtitle: string
  result: ServiceProbeResult
}) {
  const presentation =
    result.state === 'available'
      ? { symbol: '✓', label: '可用', cls: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' }
      : result.state === 'unavailable'
        ? { symbol: '!', label: '不可用', cls: 'border-rose-400/25 bg-rose-500/10 text-rose-200' }
        : result.state === 'unknown'
          ? { symbol: '?', label: '未知', cls: 'border-amber-300/25 bg-amber-400/10 text-amber-100' }
          : { symbol: '…', label: '检查中', cls: 'border-white/15 bg-white/5 text-neutral-300' }

  return (
    <div data-testid={testId} role="status" aria-live="polite" aria-atomic="true" className="rounded-xl border border-white/10 bg-black/15 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="mono text-xs font-bold uppercase tracking-wide text-white">{title}</h3>
          <p className="mt-0.5 text-[11px] text-neutral-400">{subtitle}</p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${presentation.cls}`}>
          <span aria-hidden="true" className="font-black">{presentation.symbol}</span>
          {presentation.label}
        </span>
      </div>
      <p className="mt-2 text-xs text-neutral-400">{result.summary}</p>
    </div>
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
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="选择兑换项"
          className={field + ' min-w-0 w-full max-w-full sm:w-auto'}
          value={itemId}
          onChange={(e) => setItemId(Number(e.target.value))}
        >
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
          aria-label="CDK 面额"
          className={field + ' min-w-0 w-full sm:w-32'}
          type="number"
          min={1}
          value={faceValue}
          onChange={(e) => setFaceValue(e.target.value)}
          placeholder={isLdc ? '面额*（正整数）' : '面额（LDC 用）'}
        />
        <button
          onClick={doImport}
          className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-4 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          导入
        </button>
        {stats && (
          <span className="min-w-0 break-words text-xs text-neutral-500">
            库存：可用 <b className="text-emerald-300">{stats.available}</b> / 已发 {stats.issued} / 作废{' '}
            {stats.void}
          </span>
        )}
      </div>
      <textarea
        aria-label="要导入的 CDK 码"
        className={field + ' h-28 min-w-0 w-full max-w-full font-mono'}
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
    <div className="grid min-w-0 grid-cols-1 items-center gap-2 rounded-xl bg-black/10 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(7rem,1fr)_minmax(7rem,1fr)_6rem_minmax(10rem,1.4fr)_3rem_auto]">
      <input aria-label="provider" className={field + ' min-w-0 w-full'} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="codex" />
      <input aria-label="套餐" className={field + ' min-w-0 w-full'} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="plus / *" />
      <input aria-label="积分" className={field + ' min-w-0 w-full'} type="number" value={points} onChange={(e) => setPoints(Number(e.target.value))} />
      <input aria-label="标签" className={field + ' min-w-0 w-full'} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签" />
      <label className="flex min-h-11 items-center gap-2 text-xs text-neutral-400 xl:justify-center">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
        <span className="xl:sr-only">启用</span>
      </label>
      <div className="flex flex-wrap gap-2 sm:justify-end xl:justify-start">
        <button
          type="button"
          onClick={() => onSave({ provider, plan, points, label, enabled: enabled ? 1 : 0 })}
          className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-3 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          {isNew ? '新增' : '保存'}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除发分规则 ${provider} ${plan}`}
            className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-rose-500/10 px-3 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
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
    <div className="grid min-w-0 grid-cols-1 items-center gap-2 rounded-xl bg-black/10 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(7rem,1fr)_minmax(7rem,1fr)_6rem_minmax(10rem,1.4fr)_3rem_auto]">
      {/* 存量行 provider/plan 禁改（P4-R2 codex 复审 P2）：upsert 按 (provider,plan) 键，改键＝插新行、旧行仍
          enabled 计价。改档口径＝先删旧行再新增（唯 isNew 行可编辑键）。置灰样式与信任门槛 disabled 输入一致。 */}
      <input aria-label="provider" className={field + ' min-w-0 w-full' + (isNew ? '' : ' opacity-40')} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="codex" disabled={!isNew} />
      <input aria-label="套餐" className={field + ' min-w-0 w-full' + (isNew ? '' : ' opacity-40')} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="plus / *" disabled={!isNew} />
      <input aria-label="单价" className={field + ' min-w-0 w-full'} type="number" step={0.1} min={0} value={pointsPerCall} onChange={(e) => setPointsPerCall(Number(e.target.value))} />
      <input aria-label="标签" className={field + ' min-w-0 w-full'} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签" />
      <label className="flex min-h-11 items-center gap-2 text-xs text-neutral-400 xl:justify-center">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
        <span className="xl:sr-only">启用</span>
      </label>
      <div className="flex flex-wrap gap-2 sm:justify-end xl:justify-start">
        <button
          type="button"
          onClick={() => onSave({ provider, plan, pointsPerCall, label, enabled: enabled ? 1 : 0 })}
          className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-3 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          {isNew ? '新增' : '保存'}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除折算规则 ${provider} ${plan}`}
            className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-rose-500/10 px-3 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
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
  saving,
}: {
  item?: RedeemItem
  onSave: (it: Partial<RedeemItem>, rowKey: string, idempotencyKey?: string) => Promise<boolean>
  onDelete?: () => void
  isNew?: boolean
  saving: boolean
}) {
  const [name, setName] = useState(item?.name ?? '')
  const [cost, setCost] = useState(item?.cost ?? 0)
  const [kind, setKind] = useState(item?.kind ?? 'timed_quota')
  const [fulfillment, setFulfillment] = useState<'placeholder' | 'cdk'>(item?.fulfillment ?? 'placeholder')
  const [perUserLimit, setPerUserLimit] = useState(item?.perUserLimit ?? 0)
  const [description, setDescription] = useState(item?.description ?? '')
  const [enabled, setEnabled] = useState((item?.enabled ?? 1) !== 0)
  const createIntentKey = useRef<string | null>(null)

  const changed = () => {
    if (isNew) createIntentKey.current = null
  }

  const submit = async () => {
    const rowKey = item ? `item:${item.id}` : 'new'
    if (isNew && !createIntentKey.current) createIntentKey.current = crypto.randomUUID()
    const saved = await onSave(
      { id: item?.id, name, cost, kind, fulfillment, perUserLimit, description, sort: item?.sort ?? 0, enabled: enabled ? 1 : 0 },
      rowKey,
      isNew ? createIntentKey.current ?? undefined : undefined,
    )
    if (saved && isNew) {
      setName('')
      setCost(0)
      setKind('timed_quota')
      setFulfillment('placeholder')
      setPerUserLimit(0)
      setDescription('')
      setEnabled(true)
      createIntentKey.current = null
    }
  }

  return (
    <div
      data-testid={isNew ? 'redeem-item-new-row' : `redeem-item-row-${item?.id}`}
      className="grid min-w-0 grid-cols-1 items-center gap-2 rounded-xl bg-black/10 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(8rem,1.2fr)_5rem_minmax(8rem,1fr)_minmax(7rem,1fr)_4.5rem_minmax(9rem,1.2fr)_3rem_auto]"
    >
      <input aria-label="商品名称" className={field + ' min-w-0 w-full'} value={name} disabled={saving} onChange={(e) => { changed(); setName(e.target.value) }} placeholder="名称" />
      <input aria-label="积分价" className={field + ' min-w-0 w-full'} type="number" value={cost} disabled={saving} onChange={(e) => { changed(); setCost(Number(e.target.value)) }} />
      <select aria-label="商品类型" className={field + ' min-w-0 w-full'} value={kind} disabled={saving} onChange={(e) => { changed(); setKind(e.target.value) }}>
        {KINDS.map((k) => (
          <option key={k.v} value={k.v}>
            {k.t}
          </option>
        ))}
      </select>
      <select aria-label="履约类型" className={field + ' min-w-0 w-full'} value={fulfillment} disabled={saving} onChange={(e) => { changed(); setFulfillment(e.target.value as 'placeholder' | 'cdk') }} title="履约类型">
        {FULFILLMENTS.map((f) => (
          <option key={f.v} value={f.v}>
            {f.t}
          </option>
        ))}
      </select>
      <input
        className={field + ' min-w-0 w-full'}
        type="number"
        min={0}
        value={perUserLimit}
        disabled={saving}
        onChange={(e) => { changed(); setPerUserLimit(Number(e.target.value)) }}
        title="每人限购（0=不限）"
        placeholder="限购"
        aria-label="每人限购"
      />
      <input aria-label="商品说明" className={field + ' min-w-0 w-full'} value={description} disabled={saving} onChange={(e) => { changed(); setDescription(e.target.value) }} placeholder="说明" />
      <label className="flex min-h-11 items-center gap-2 text-xs text-neutral-400 xl:justify-center">
        <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => { changed(); setEnabled(e.target.checked) }} className="h-4 w-4 accent-emerald-500" />
        <span className="xl:sr-only">启用</span>
      </label>
      <div className="flex flex-wrap gap-2 sm:justify-end xl:justify-start">
        <button
          type="button"
          data-testid="redeem-item-save"
          onClick={() => void submit()}
          disabled={saving}
          className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[var(--brand)]/20 px-3 text-xs font-medium text-[var(--brand-bright)] transition-colors hover:bg-[var(--brand)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '保存中…' : isNew ? '新增' : '保存'}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除兑换项 ${name}`}
            className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-rose-500/10 px-3 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            删
          </button>
        )}
      </div>
    </div>
  )
}
