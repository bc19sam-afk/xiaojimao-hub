import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { env } from './env'
import {
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  invalidOutboundShape,
  outboundJson,
  outboundOk,
  OutboundRequestError,
} from './outbound-http'

// ============================================================================
// CPA 客户端抽象层（多 provider：codex / claude / grok）
//
// 所有对 cpamp/CPA 的调用都关在这里。cpamp/CPA 升级只改这一个文件。
//
// 两种授权流程（已实测）：
//   redirect（codex/anthropic）：拿授权URL → 用户授权 → 粘贴回调URL → oauth-callback
//   device  （xai/grok）        ：拿URL+user_code → 用户去输码 → 轮询 get-auth-status
// 真实端点：
//   GET  /v0/management/{cpaProvider}-auth-url?is_webui=true
//   GET  /v0/management/get-auth-status?state=
//   POST /v0/management/oauth-callback {provider, redirect_url}
//   POST /v0/management/auth-files (multipart)         直接上传号（RT 路径，codex）
//   GET/PATCH/DELETE /v0/management/auth-files[...]
//   POST/GET /v0/management/codex-inspection[...]
// ============================================================================

export type ProviderId = 'codex' | 'claude' | 'grok'
// UI provider → CPA provider 名
const CPA_PROVIDER: Record<ProviderId, string> = {
  codex: 'codex',
  claude: 'anthropic',
  grok: 'xai',
}

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'

export interface AuthFile {
  name: string
  accountId: string
  email: string
  plan: string
  disabled: boolean
  provider?: ProviderId // 识别不出时 undefined（findNew 会保守跳过）
  priority?: number // 仅 mockClient 填（供测试读回验证入池设优先级）；realClient 读侧不填——R1 实测 cpamp GET auth-files 无此字段
}

// 文件的 provider 标识（type 字段或文件名前缀）→ ProviderId。
// 两套名字都认：codex；claude=anthropic；grok=xai。识别不出返回 undefined。
function providerFromToken(token: string | undefined): ProviderId | undefined {
  switch ((token || '').toLowerCase()) {
    case 'codex':
      return 'codex'
    case 'claude':
    case 'anthropic':
      return 'claude'
    case 'grok':
    case 'xai':
      return 'grok'
    default:
      return undefined
  }
}
export interface IngestResult {
  accountId: string
  email: string
  plan: string
  authFileName: string
  duplicate: boolean
}
export interface StartResult {
  state: string
  url: string
  flow: 'redirect' | 'device'
  userCode?: string
}
// device 轮询结果
export type CheckResult =
  | { status: 'ok'; ingest: IngestResult }
  | { status: 'wait' }
  | { status: 'error'; error: string }

export type ProbeDecision = 'ok' | 'retry' | 'reauth' | 'reject'
export interface ProbeResult {
  accountId: string
  decision: ProbeDecision
  plan: string
  reason: string
  // 探测结果所属 provider（归一后的内部名）。**可选**：线上 cpamp 版本未知，老版本巡检结果可能
  // 不带 provider 字段——写死必填会让消费方按复合键查不到任何结果（首检号永不入池、存活巡检永不
  // 判失效＝静默零收益）。消费方按 probeKey() 建/查键并回落（见 collect.ts），provider 在时消除
  // 跨 provider 同 accountId 撞键，provider 缺时行为与今天完全一致。
  provider?: ProviderId
}

// 按号按自然日的调用量（P2-R2 按量计量数据源）。date＝'YYYY-MM-DD' 自然日（时区随服务器）、
// count＝该号该日调用次数。settleDailyUsage 据此折算积分、按日结算发给号主。
export interface DailyUsage {
  accountId: string
  provider: ProviderId
  date: string
  count: number
}

// knownAccountIds 语义：**该 provider** 已入库的 accountId 列表（不是全局）。
// account_id 命名空间按 provider 独立，跨 provider 撞同一 id 是合法新号，
// 故判重必须按 provider 划界——调用方（collect.ts）负责按 provider 过滤后传入。
export interface CpaClient {
  startOAuth(provider: ProviderId): Promise<StartResult>
  // redirect 流程：提交回调 URL 完成。before＝授权前 auth-files 文件名快照（P1b-4 由 collect 层从
  // 按 state 持久化的快照读出后传入），交给 findNew 挡号池既有号（见 findNew 注释③）。
  finishOAuth(
    provider: ProviderId,
    redirectUrl: string,
    knownAccountIds: string[],
    before: Set<string>,
  ): Promise<IngestResult>
  // device 流程：轮询一次，ok 则落号。before 同上（device 跨请求，快照由 startOAuth 拍并持久化）。
  checkOAuth(
    provider: ProviderId,
    state: string,
    knownAccountIds: string[],
    before: Set<string>,
  ): Promise<CheckResult>
  // 直贴 RT（仅 codex）；knownAccountIds 为 codex 的已知 accountId
  ingestRefreshToken(rt: string, knownAccountIds: string[]): Promise<IngestResult>
  listAuthFiles(): Promise<AuthFile[]>
  setDisabled(name: string, disabled: boolean): Promise<void>
  // 设单号优先级（cpamp 数字越大越优先）。贡献号入池即调（§2.5），best-effort。
  setPriority(name: string, priority: number): Promise<void>
  deleteAuthFile(name: string): Promise<void>
  inspect(): Promise<ProbeResult[]>
  // 按号按自然日的调用量（P2-R2）。settleDailyUsage 周期拉取 → 折算积分 → 按日发给号主。
  getDailyUsage(): Promise<DailyUsage[]>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const OAUTH_STATUS_MAX_POLLS = 15
const OAUTH_STATUS_POLL_DELAY_MS = 1_000
// redirect finish 的外呼最坏上界：callback + 每轮 status timeout/sleep + 最终 findNew 列表。
// collect 层还会另加 isolate timeout 与余量，作为 operation fencing TTL。
export const MAX_OAUTH_FINISH_DURATION_MS =
  DEFAULT_OUTBOUND_TIMEOUT_MS +
  OAUTH_STATUS_MAX_POLLS * (DEFAULT_OUTBOUND_TIMEOUT_MS + OAUTH_STATUS_POLL_DELAY_MS) +
  DEFAULT_OUTBOUND_TIMEOUT_MS

// ---------------------------------------------------------------------------
// 模拟实现（文件持久化，模拟真实 CPA 的跨进程共享状态）
// ---------------------------------------------------------------------------
function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}
// 毫秒 → 'YYYY-MM-DD' 自然日（服务器本地时区，§3.3「时区随服务器」）。
// ⚠️ 故意与 lib/settle.ts 的同名助手各留一份：保 cpa.ts 只依赖 env（低层「所有 CPA 调用关这里」），
// 不为一个 3 行日期助手引入 cpa→settle 反向依赖。两处实现须一致（同为本地时区 YMD）。
function dayStr(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
const MOCK_CPA_PATH = process.env.MOCK_CPA_PATH || join(process.cwd(), 'data', 'mock-cpa.json')
function mockLoad(): Map<string, AuthFile> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(MOCK_CPA_PATH, 'utf8')) as Record<string, AuthFile>))
  } catch {
    return new Map()
  }
}
function mockSave(store: Map<string, AuthFile>): void {
  mkdirSync(dirname(MOCK_CPA_PATH), { recursive: true })
  writeFileSync(MOCK_CPA_PATH, JSON.stringify(Object.fromEntries(store), null, 2), 'utf8')
}
const MOCK_PLAN: Record<ProviderId, string> = { codex: 'plus', claude: 'pro', grok: 'super' }
// seed 决定 accountId（provider 无关：同 seed 跨 provider → 同 accountId，模拟同一上游号）。
// authFileName 含 provider 前缀，故判重天然按 (provider, accountId) 划界：
// 同 provider 同 seed 二次提交 → duplicate；跨 provider 同 seed → 各落一份。
function mockCreate(provider: ProviderId, seed: string): IngestResult {
  const store = mockLoad()
  const accountId = `acct_${hash(seed)}`
  const authFileName = `${provider}-${accountId}.json`
  if (store.has(authFileName)) return { accountId, email: '', plan: MOCK_PLAN[provider], authFileName, duplicate: true }
  const email = `${provider}_${hash(seed).slice(0, 6)}@example.com`
  store.set(authFileName, { name: authFileName, accountId, email, plan: MOCK_PLAN[provider], disabled: true, provider })
  mockSave(store)
  return { accountId, email, plan: MOCK_PLAN[provider], authFileName, duplicate: false }
}

const mockClient: CpaClient = {
  async startOAuth(provider) {
    const state = hash('s' + Math.random())
    if (provider === 'grok') {
      return { state, url: 'https://accounts.x.ai/oauth2/device?mock=1', flow: 'device', userCode: 'MOCK-' + state.slice(0, 4).toUpperCase() }
    }
    return { state, url: `https://auth.openai.com/oauth/authorize?mock=1&state=${state}`, flow: 'redirect' }
  },
  async finishOAuth(provider, redirectUrl) {
    // seed 取回调 URL：同一号重复提交幂等落同一 accountId（与真实语义一致）
    return mockCreate(provider, redirectUrl)
  },
  async checkOAuth(provider, state) {
    // mock：直接当作已授权，造号。seed 取 state，同一授权会话轮询幂等
    return { status: 'ok', ingest: mockCreate(provider, state) }
  },
  async ingestRefreshToken(rt) {
    return mockCreate('codex', 'rt' + rt.slice(0, 12))
  },
  async listAuthFiles() {
    return [...mockLoad().values()]
  },
  async setDisabled(name, disabled) {
    const store = mockLoad()
    const f = store.get(name)
    if (f) { f.disabled = disabled; mockSave(store) }
  },
  async setPriority(name, priority) {
    const store = mockLoad()
    const f = store.get(name)
    if (f) { f.priority = priority; mockSave(store) } // 持久化，供测试经 listAuthFiles() 读回验证
  },
  async deleteAuthFile(name) {
    const store = mockLoad()
    store.delete(name)
    mockSave(store)
  },
  async inspect() {
    return [...mockLoad().values()].map((f) => {
      const bad = hash(f.accountId).charCodeAt(0) % 10 === 0
      return { accountId: f.accountId, decision: bad ? ('reject' as const) : ('ok' as const), plan: f.plan, reason: bad ? 'unauthorized' : 'ok', provider: f.provider }
    })
  },
  async getDailyUsage() {
    // MOCK：给号池里每个（能识别 provider 的）号编造稳定用量——按 accountId hash 出每日次数，
    // 给「昨天」一笔（可被 settleDailyUsage 结算 → 驱动端到端发分演示）+「今天」一笔（进行中不结）。
    const now = Date.now()
    const out: DailyUsage[] = []
    for (const f of mockLoad().values()) {
      if (!f.provider) continue
      const base = 10 + (parseInt(hash(f.accountId), 36) % 50) // 稳定 10..59 次/日
      out.push({ accountId: f.accountId, provider: f.provider, date: dayStr(now - 86_400_000), count: base })
      out.push({ accountId: f.accountId, provider: f.provider, date: dayStr(now), count: base + 3 })
    }
    return out
  },
}

// ---------------------------------------------------------------------------
// 真实实现
// ---------------------------------------------------------------------------
function api(path: string): string {
  return `${env.cpa.baseUrl}${path}`
}
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${env.cpa.managementKey}`, ...extra }
}
// cpamp HTTP 报错对外统一中性文案（§8）：绝不把状态码/响应体/内部 API 路径透传前端。
// 出站层日志只保留固定 service/operation、错误类别与状态码，不记录 URL 或响应体。
export const CPA_UNAVAILABLE = '账号服务暂时不可用，请稍后重试'
function oauthTerminal(message = '授权失败'): Error {
  return Object.assign(new Error(message), { oauthTerminal: true })
}

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = { method, headers: authHeaders(), cache: 'no-store' }
  if (body !== undefined) {
    init.headers = authHeaders({ 'Content-Type': 'application/json' })
    init.body = JSON.stringify(body)
  }
  try {
    return await outboundJson(api(path), init, {
      service: 'cpa',
      operation: `management_${method.toLowerCase()}`,
    })
  } catch (error) {
    if (error instanceof OutboundRequestError) {
      throw new Error(CPA_UNAVAILABLE)
    }
    throw error
  }
}

async function reqOk(method: string, path: string, body?: unknown): Promise<void> {
  const init: RequestInit = { method, headers: authHeaders(), cache: 'no-store' }
  if (body !== undefined) {
    init.headers = authHeaders({ 'Content-Type': 'application/json' })
    init.body = JSON.stringify(body)
  }
  try {
    await outboundOk(api(path), init, {
      service: 'cpa',
      operation: `management_${method.toLowerCase()}`,
    })
  } catch (error) {
    if (error instanceof OutboundRequestError) throw new Error(CPA_UNAVAILABLE)
    throw error
  }
}

interface RawFile {
  name?: string; filename?: string; type?: string; provider?: string
  account_id?: string; accountId?: string; account?: string; sub?: string
  email?: string; plan?: string; planType?: string; disabled?: boolean
}
function normFile(f: RawFile): AuthFile {
  const name = f.name ?? f.filename ?? ''
  // provider：依次认显式 provider 字段、type 字段、文件名前缀（首个 '-' 前）——
  // 真实 cpamp 的字段/命名未完全确定，三条路都认，识别不出才落 undefined
  const provider =
    providerFromToken(f.provider) ?? providerFromToken(f.type) ?? providerFromToken(name.split('-')[0])
  return {
    name,
    // 稳定业务 ID 的字段名跨 provider 不同，每条兜底都按 provider 划界、绝不跨 provider 泛认
    // （泛认未验证字段会把错的当 canonical ID 放行发分）：
    //   codex  —— account_id；
    //   claude —— account（P0-A 实测，无 account_id；R1：该 account 值本身=邮箱、含 PII，下游须按 §8 敏感值对待）；
    //   grok   —— sub（OIDC subject；P0-A 扒 CLIProxyAPI xai 源码确认为稳定唯一标识，跨重授权稳定）。
    // account_id/accountId 最优先；也绝不用 claude 的 id 字段（那非稳定业务 ID，会把唯一键锚错）。
    accountId:
      f.account_id ??
      f.accountId ??
      (provider === 'claude' ? f.account : undefined) ??
      (provider === 'grok' ? f.sub : undefined) ??
      '',
    email: f.email ?? '',
    // R1 核对（§二①）：claude auth-file 无 plan/planType 字段 → 归一 'unknown'（维持现状；要显示套餐需另找来源）
    plan: f.plan ?? f.planType ?? 'unknown',
    disabled: Boolean(f.disabled),
    provider,
  }
}
function parseIdToken(idToken: string): { accountId: string; email: string } {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'))
    const auth = payload['https://api.openai.com/auth'] ?? {}
    return {
      accountId: auth.chatgpt_account_id ?? payload.chatgpt_account_id ?? payload.account_id ?? '',
      email: payload.email ?? '',
    }
  } catch {
    return { accountId: '', email: '' }
  }
}

async function getAuthStatus(state: string): Promise<{ status: string; error?: string }> {
  return (await req('GET', `/v0/management/get-auth-status?state=${encodeURIComponent(state)}`)) as {
    status: string
    error?: string
  }
}
// 授权完成后，找出**当前 provider** 新落的号。三重过滤：
//   ① provider——绝不跨 provider 拿错号；识别不出 provider 的文件保守跳过；
//   ② known（该 provider 已知 accountId）——只含该 provider，故跨 provider 同 id 不误判重复；
//   ③ before——授权动作**之前**的 auth-files 文件名快照，只认快照外的**新文件**。
// ③ 是防「抢注号池既有号」的关键：cpamp 号池官方号/贡献号共用，池里本就有一堆不属于 hub
//   （不在 known）的号；没有快照时 findNew 会把池中某个既有号误当成用户刚授权的新号，进而记到
//   提交者名下、被 isolate() 禁用（那是生产号！）、错发分。before 用文件名（f.name）做身份——
//   比 accountId 稳、且唯一。before 为空集 → 该条件恒真＝退化为原行为（无快照的调用方仍可用）。
export async function findNew(
  client: CpaClient,
  provider: ProviderId,
  known: Set<string>,
  before: Set<string> = new Set(),
): Promise<IngestResult> {
  const files = await client.listAuthFiles()
  const fresh = files.filter((f) => f.provider === provider && f.accountId && !before.has(f.name))
  const created = fresh.find((f) => !known.has(f.accountId))
  if (created) {
    return { accountId: created.accountId, email: created.email, plan: created.plan, authFileName: created.name, duplicate: false }
  }
  // 快照外有新文件、但 accountId 已在 known ＝「已交过的号重新授权又落了一份文件」
  // （典型：号被拒后文件已删，用户重交——§2.4 要拦的场景）。带回 accountId 让 collect 层
  // 报「这个号交过了」而非「未能确认」；authFileName 留空——绝不能让 isolate() 去禁用
  // 池中那个可能正在服务的文件（重交不该有任何外部副作用）。
  const rejoined = fresh.find((f) => known.has(f.accountId))
  if (rejoined) {
    return { accountId: rejoined.accountId, email: rejoined.email, plan: rejoined.plan, authFileName: '', duplicate: true }
  }
  // 快照外无本 provider 新文件：授权未完成 / 文件被 cpamp 原地覆盖（重交在池号，原理上与
  // 未完成不可区分，彻底区分留 P1b-5 响应关联）→ 认不出，collect 层报「未能确认」。
  return { accountId: '', email: '', plan: 'unknown', authFileName: '', duplicate: true }
}

const realClient: CpaClient = {
  async startOAuth(provider) {
    const cp = CPA_PROVIDER[provider]
    const data = (await req('GET', `/v0/management/${cp}-auth-url?is_webui=true`)) as {
      state: string; url: string; flow?: string; user_code?: string
    }
    const flow: 'redirect' | 'device' = data.flow === 'device' || data.user_code ? 'device' : 'redirect'
    return { state: data.state, url: data.url, flow, userCode: data.user_code }
  },

  async finishOAuth(provider, redirectUrl, knownAccountIds, before) {
    const known = new Set(knownAccountIds)
    let state = ''
    try {
      state = new URL(redirectUrl).searchParams.get('state') ?? ''
    } catch {
      throw new Error('回调链接格式不对，请粘贴完整的地址栏 URL')
    }
    // before＝授权前 auth-files 文件名快照（P1b-4：由 collect 层在 startOAuth 拍、按 state 持久化后读入
    // 传来）。快照拍于授权动作之前，findNew 只认快照外的新文件名，避免把号池既有号（不在 hub known、
    // 授权前就存在）误当成用户刚授权的新号（见 findNew 注释③）。持久化跨请求＝retry 读同一快照不孤立。
    await reqOk('POST', '/v0/management/oauth-callback', {
      provider: CPA_PROVIDER[provider],
      redirect_url: redirectUrl,
    })
    if (state) {
      let completed = false
      for (let i = 0; i < OAUTH_STATUS_MAX_POLLS; i++) {
        const s = await getAuthStatus(state)
        if (s.status === 'ok') {
          completed = true
          break
        }
        if (s.status === 'error') {
          console.error('[cpa] oauth_status terminal_error')
          throw oauthTerminal()
        }
        await sleep(OAUTH_STATUS_POLL_DELAY_MS)
      }
      // 未到明确终态时不猜新文件；保留 collect 层 session/lease，让同一 state 可安全重试。
      if (!completed) throw new Error('授权仍在处理中，请稍后重试')
    }
    return findNew(this, provider, known, before)
  },

  async checkOAuth(provider, state, knownAccountIds, before) {
    const s = await getAuthStatus(state)
    if (s.status === 'error') {
      console.error('[cpa] oauth_status terminal_error')
      return { status: 'error', error: '授权失败' }
    }
    if (s.status !== 'ok') return { status: 'wait' }
    // device 流程跨请求（startOAuth 拿 state → 用户别处授权 → 本请求轮询落号）：授权前快照由
    // startOAuth 拍、按 state 持久化，collect 层读出后作 before 传入（P1b-4 修好了 P1b-3 遗留的
    // 「device 传空 before」抢注洞）。findNew 只认快照外新文件，挡号池既有号（见 findNew 注释③）。
    const ingest = await findNew(this, provider, new Set(knownAccountIds), before)
    return { status: 'ok', ingest }
  },

  async ingestRefreshToken(rt, knownAccountIds) {
    const known = new Set(knownAccountIds)
    let raw: unknown
    try {
      raw = await outboundJson(
        OPENAI_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', client_id: OPENAI_CLIENT_ID, refresh_token: rt, scope: 'openid profile email offline_access' }),
        },
        { service: 'openai', operation: 'refresh_token' },
      )
    } catch (error) {
      if (
        error instanceof OutboundRequestError &&
        error.kind === 'http' &&
        (error.status === 400 || error.status === 401)
      ) {
        throw new Error('Refresh Token 无效或已过期')
      }
      throw new Error(CPA_UNAVAILABLE)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(CPA_UNAVAILABLE)
    const tok = raw as { access_token?: unknown; id_token?: unknown; refresh_token?: unknown }
    if (typeof tok.access_token !== 'string' || !tok.access_token || typeof tok.id_token !== 'string' || !tok.id_token) {
      throw new Error(CPA_UNAVAILABLE)
    }
    const { accountId, email } = parseIdToken(tok.id_token)
    if (!accountId) throw new Error('无法从令牌解析账号信息')
    if (known.has(accountId)) return { accountId, email, plan: 'unknown', authFileName: '', duplicate: true }
    const authFile = {
      type: 'codex', id_token: tok.id_token, access_token: tok.access_token,
      refresh_token: typeof tok.refresh_token === 'string' && tok.refresh_token ? tok.refresh_token : rt,
      account_id: accountId, email, last_refresh: new Date().toISOString(),
    }
    const fileName = `codex-${accountId}.json`
    const form = new FormData()
    form.append('file', new Blob([JSON.stringify(authFile)], { type: 'application/json' }), fileName)
    try {
      await outboundOk(
        api('/v0/management/auth-files'),
        { method: 'POST', headers: authHeaders(), body: form },
        { service: 'cpa', operation: 'auth_file_upload' },
      )
    } catch {
      throw new Error(CPA_UNAVAILABLE)
    }
    return { accountId, email, plan: 'unknown', authFileName: fileName, duplicate: false }
  },

  async listAuthFiles() {
    const data = await req('GET', '/v0/management/auth-files')
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray((data as { files?: unknown }).files)) {
      try {
        invalidOutboundShape('cpa', 'auth_files_list')
      } catch {
        throw new Error(CPA_UNAVAILABLE)
      }
    }
    return ((data as { files: RawFile[] }).files).map(normFile)
  },
  async setDisabled(name, disabled) {
    await reqOk('PATCH', '/v0/management/auth-files/status', { name, disabled })
  },
  async setPriority(name, priority) {
    // 端点/字段/生效链已按 CLIProxyAPI 上游 main 源码核对（对接-R2b codex 双通道复查）：
    //   • 路由表 internal/api/server.go:944-951 mgmt 组仅注册 PATCH /auth-files/status 与
    //     /auth-files/fields——**无 /auth-files/priority**（旧占位猜测真发必 404）。正确端点＝
    //     PATCH /v0/management/auth-files/fields，体 { name, priority }（priority 为 JSON number）。
    //   • PatchAuthFileFields(handlers/management/auth_files.go:1487)：name 必填（匹配 FileName/ID），
    //     其余键作 metadata 字段路径写入 auth 文件；404=文件不存在、200={status:"ok"}。
    //   • 生效链：synthesizer(watcher/synthesizer/file.go:187-198) 读 metadata["priority"]→
    //     Attributes["priority"]；selector(sdk/cliproxy/auth/selector.go:115) authPriority Atoi 后
    //     collectAvailableByPriority 按优先级分桶调度（数字越大越先，与 P0-A 记载闭环）。
    // ⚠️ 仍未对真实实例发过写，且线上 cpamp 版本可能滞后于上游 main——对接-R3 用一次性测试号
    //   实测后方可视为已验。本单 realClient 依旧不真调（全部验证走 MOCK）。
    await reqOk('PATCH', '/v0/management/auth-files/fields', { name, priority })
  },
  async deleteAuthFile(name) {
    await reqOk('DELETE', `/v0/management/auth-files?name=${encodeURIComponent(name)}`)
  },
  // 🔴 不变量（P6-R2 R7-P2③ + 对接-R3b）：**本函数只在 run.status === 'completed' 时正常返回**，
  //    没到可验证成功终态一律抛错。results 只是载荷：字段存在、空数组或非空数组都不能单独证明 run
  //    已完成。返回 [] 因此单义地表示「completed 且本轮零结果」（号刚落、cpamp 侧还没登记），
  //    那是正常情况、不是故障。
  //
  //    修复前有两条**不抛的失败路径**都 `return []`：
  //      ① POST run 返回 200 但体里没有 run.id（cpamp 侧建不起巡检任务）；
  //      ② 轮询 30 轮（约 30s）后 run 仍未 completed、results 仍未出现 → `detail.results ?? []`。
  //    对接-R3b 又证实：真实首次 GET 可为 running + results: []。旧条件把 [] 的 truthy 当完成，
  //    会在最终 completed 结果到达前提前返回；running + 非空 partial results 同样不能视为最终集合。
  //    调用方（collect.ts 的 processPending / checkPooledHealth）看到空数组就一个号都不处理，
  //    却留 inspectFailed=false ⇒ dead-man 心跳照报健康，而首检/存活巡检链路实际已不可用
  //    （codex 号一个也进不了池、失效号一个也停不掉），且**完全静默**。
  //
  //    ⚠️ 为什么收在这一层而不是 collect.ts：空数组在调用方那里是**三义**的——「没跑成」「跑完
  //       零结果」「跑完但没覆盖到目标号」。按 `probes.length === 0` 判故障会把后两者一起误报，
  //       心跳恒不发（已有测试钉住：inspection-mapping「inspect 正常（哪怕本轮一个号都没通过）」、
  //       health-dashboard「R4-P2③ 反向」）。只有这里还分得清，故在这里把「没跑成」转成异常，
  //       让调用方现成的 catch（不可观测 → 本轮跳过、置健康信号、绝不误停/误退回）自动接住。
  //    ⚠️ 抛的是 CPA_UNAVAILABLE：与 req() 失败同一对外文案（§8：绝不透传 cpamp 内部细节），
  //       调用方只 catch 不看 message，语义一致。
  async inspect() {
    const run = (await req('POST', '/v0/management/codex-inspection/run', {})) as { run?: { id?: number } }
    const id = run.run?.id
    if (!id) {
      console.error('[cpa] codex-inspection/run 未返回 run.id，本轮巡检未能发起') // 原文只进服务端日志
      throw new Error(CPA_UNAVAILABLE)
    }
    let detail: { run?: { status?: string }; results?: RawInspectionResult[] } = {}
    let done = false
    for (let i = 0; i < 30; i++) {
      detail = (await req('GET', `/v0/management/codex-inspection/runs/${id}`)) as typeof detail
      if (detail.run?.status === 'completed') {
        done = true
        break
      }
      await sleep(1000)
    }
    if (!done) {
      console.error(`[cpa] codex-inspection run ${id} 轮询 30 次仍未就绪，本轮巡检结果不可观测`)
      throw new Error(CPA_UNAVAILABLE)
    }
    return (detail.results ?? []).map(mapInspection)
  },
  async getDailyUsage() {
    // R1 已核对（docs/probe-cpamp-real-R1.md §二②）：真实 usage 事件的三层结构与 account_snapshot /
    //   auth_provider_snapshot / auth_label_snapshot / timestamp 字段名与本实现完全吻合、无结构性错配。
    //   数据源 GET /v0/management/usage（P0-A 实探）：
    //   { apis: { [端点]: { models: { [模型]: { details: [...] } } } } }，每条 detail = 一次请求。
    // 计量口径（§3.1/P0-A）：按 (auth_provider_snapshot, account_snapshot) 分组、timestamp 落自然日、
    //   数 details 条数 = 该号当日调用次数（贡献号判定见 isHubContribution，现阶段恒放行）。
    try {
      return parseDailyUsage(await req('GET', '/v0/management/usage'))
    } catch (err) {
      if (err instanceof Error && err.message === CPA_UNAVAILABLE) throw err
      const code = err instanceof UsagePayloadError ? err.code : 'transport_or_json'
      console.error(`[cpa] usage unavailable: ${code}`)
      throw new Error(CPA_UNAVAILABLE)
    }
  },
}

interface RawInspectionResult {
  accountId?: string; disabled?: boolean; status?: string; action?: string
  actionReason?: string; statusCode?: number | null; isQuota?: boolean; planType?: string; errorKind?: string
  provider?: string
}
// action=keep 但 errorKind 是**健康分类**而非错误的白名单：xai 深度探测复用 errorKind 字段装健康
// 结论（CPA-Manager-Plus apps/manager-server/internal/service/codexinspection/xai_probe.go:130/:172/
// :248/:254/:257，其中 :172 处 official_api_healthy 被当健康证据用）。这几个值必须继续判 ok，
// 否则将来开 xai 巡检后健康 grok 号永远入不了池、号主零收益。
const HEALTHY_ERROR_KINDS = new Set(['inference_healthy', 'official_api_healthy', 'billing_healthy', 'billing_partial'])
// cpamp codex-inspection 建议动作（P0-A 文档）→ ProbeDecision。文档动作：保留 keep / 启用 enable /
// 重新登录 relogin / 禁用 disable / 删除 delete。⚠️ relogin/disable 必须在 `!errorKind→ok` 宽松兜底
// **之前**拦截——否则「需重登/被禁用」的号无 errorKind 时会 fall-through 成 ok→被当健康发分。
// （真实 cpamp 的 action 字段名待对接样本最终核对，见 P1b-5 类「真实对接前必验」清单。）
export function mapInspection(r: RawInspectionResult): ProbeResult {
  const code = r.statusCode ?? 0
  const plan = (r.planType || 'unknown').toLowerCase()
  const reason = r.actionReason || r.errorKind || r.status || ''
  let decision: ProbeDecision
  // disable=禁用观察（额度超阈/状态异常）→ 软失败：不判死、继续观察（reason 词表在 observationKind 再细分）
  if (r.isQuota || code === 402 || code === 429 || r.action === 'disable') decision = 'retry'
  else if (code === 401 || r.errorKind === 'invalidated' || r.action === 'delete') decision = 'reject'
  // relogin/reauth=OAuth 失效需重授权 → 转人工复核（不作为观测事件，见 processPending）
  else if (r.action === 'reauth' || r.action === 'relogin' || r.errorKind === 'reauth') decision = 'reauth'
  // cpamp 把「探测没拿到有效应答」的号也标成 action=keep（保守保留、别乱动），并在 errorKind 里
  // 记原因：missing_auth_index（没探）/ request_error（请求异常）/ missing_status（应答无
  // status_code）/ http_status（非 2xx）。keep≠健康——这些号从没被证实能登录，当 ok 放行会让
  // 未验证的号入池锁唯一键并开始计量发分（违反 collect.ts 首检纪律）→ 判 retry，留首检下轮再查。
  // ⚠️ 例外：xai 深度探测复用 errorKind 装**健康分类**（xai_probe.go），这几个值是健康证据不是
  // 错误，粗暴地「keep+任意 errorKind→retry」会让健康 grok 号永远入不了池、号主零收益。
  // 方向取 fail-closed：未列入健康白名单的 errorKind 一律 retry（retry 不判死，只是晚一轮）。
  else if (r.action === 'keep' && r.errorKind && !HEALTHY_ERROR_KINDS.has(r.errorKind)) decision = 'retry'
  else if (code === 200 || r.action === 'enable' || r.action === 'keep' || !r.errorKind) decision = 'ok'
  else decision = 'retry'
  // provider 必须过 providerFromToken 归一（cpamp 发 "xai"、我方内部叫 "grok"），绝不裸透传；
  // 认不出 → undefined（消费方回落按裸 accountId 匹配，见 ProbeResult.provider 注释）。
  return { accountId: r.accountId ?? '', decision, plan, reason, provider: providerFromToken(r.provider) }
}

const USAGE_ROW_LIMIT = 50_000

class UsagePayloadError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

function usageFail(code: string): never {
  throw new UsagePayloadError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDailyUsage(raw: unknown): DailyUsage[] {
  if (!isRecord(raw) || !isRecord(raw.apis)) usageFail('invalid_apis')
  if (Object.prototype.hasOwnProperty.call(raw, 'total_requests')) {
    const hintedTotal = raw.total_requests
    if (typeof hintedTotal !== 'number' || !Number.isSafeInteger(hintedTotal) || hintedTotal < 0) {
      usageFail('invalid_total_requests')
    }
    if (hintedTotal >= USAGE_ROW_LIMIT) usageFail('usage_row_limit')
  }

  const agg = new Map<string, DailyUsage>() // key = provider\0accountId\0date
  let detailCount = 0
  for (const apiEntry of Object.values(raw.apis)) {
    if (!isRecord(apiEntry) || !isRecord(apiEntry.models)) usageFail('invalid_models')
    for (const model of Object.values(apiEntry.models)) {
      if (!isRecord(model) || !Array.isArray(model.details)) usageFail('invalid_details')
      for (const detail of model.details) {
        if (!isRecord(detail)) usageFail('invalid_detail')
        detailCount++
        if (!Number.isSafeInteger(detailCount)) usageFail('detail_count_overflow')
        if (detailCount >= USAGE_ROW_LIMIT) usageFail('usage_row_limit')

        const accountId = detail.account_snapshot
        const providerToken = detail.auth_provider_snapshot
        if (typeof accountId !== 'string' || accountId.trim() === '') usageFail('invalid_detail_account')
        if (typeof providerToken !== 'string') usageFail('invalid_detail_provider')
        const provider = providerFromToken(providerToken)
        if (!provider) usageFail('invalid_detail_provider')
        const timestamp = tsToMs(detail.timestamp)
        const label = typeof detail.auth_label_snapshot === 'string' ? detail.auth_label_snapshot : undefined

        // R1 已核对：auth_label_snapshot 是 cpamp 自带账号 label（=邮箱）、非 hub 来源标记；贡献号判定见
        // isHubContribution（现阶段恒放行）。专用 hub 来源标记写入见后续单（对接-R3）。
        if (!isHubContribution(label)) continue
        const date = dayStr(timestamp)
        const key = `${provider}\0${accountId}\0${date}`
        const current = agg.get(key)
        if (current) {
          const next = current.count + 1
          if (!Number.isSafeInteger(next)) usageFail('aggregate_count_overflow')
          current.count = next
        } else {
          agg.set(key, { accountId, provider, date, count: 1 })
        }
      }
    }
  }
  return [...agg.values()]
}
// 🔴 R1 已核对（docs/probe-cpamp-real-R1.md §二⑤/三.1）：真实 auth_label_snapshot = 账号自带 label
// （= 邮箱），containsHub=false——它**不是** hub 注入的来源标记。故绝不可把 label 预过滤「升级回」按
// 「label 含 'hub'」硬闸：真实贡献号 label 里没有 'hub'，一旦硬过滤→贡献号被误剔除→生产零发分。
// 归属权威判定由 settle 层 pooled 号索引负责（(provider, account_id) 匹配）；此处维持恒放行。
// label 预过滤保持关闭，直到将来单独写入**专用 hub 来源标记字段**（非现有 auth_label_snapshot）——
// 「来源标记写入」已立项（对接-R3/后续单），落地后方可用那个新字段做预过滤。切勿改本函数逻辑。
function isHubContribution(_label: string | undefined): boolean {
  return true // 放行；归属判定交给 settle 层 pooled 索引（R1 红线：真实 label 不含 'hub'，勿硬过滤）
}
// R1 已核对（§二④）：真实 timestamp = UTC ISO-8601 字符串（如 2026-07-16T13:53:50.795Z），走 Date.parse
// 分支解析成功；数字秒/毫秒分支对 claude 不触发，防御性保留。⚠️ 运维：源时间是 UTC，tsToMs→dayStr 落
// 服务器本地时区日，故生产机时区必须对齐目标结算时区（与已知 CI-UTC-grace-window flaky 同源）。
function hasValidIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(0)
  probe.setUTCHours(0, 0, 0, 0)
  probe.setUTCFullYear(year, month - 1, day)
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
}

function tsToMs(ts: unknown): number {
  let value: number
  if (typeof ts === 'number') {
    if (!Number.isSafeInteger(ts) || ts < 0) usageFail('invalid_detail_timestamp')
    value = ts < 1e12 ? ts * 1000 : ts
  } else if (typeof ts === 'string' && ts.trim() !== '') {
    const timestamp = ts.trim()
    if (!hasValidIsoTimestamp(timestamp)) usageFail('invalid_detail_timestamp')
    value = Date.parse(timestamp)
  } else {
    usageFail('invalid_detail_timestamp')
  }
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) {
    usageFail('invalid_detail_timestamp')
  }
  return value
}

export const cpa: CpaClient = env.mock ? mockClient : realClient
