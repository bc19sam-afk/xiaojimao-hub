import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { env } from './env'

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
  deleteAuthFile(name: string): Promise<void>
  inspect(): Promise<ProbeResult[]>
  // 按号按自然日的调用量（P2-R2）。settleDailyUsage 周期拉取 → 折算积分 → 按日发给号主。
  getDailyUsage(): Promise<DailyUsage[]>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  async deleteAuthFile(name) {
    const store = mockLoad()
    store.delete(name)
    mockSave(store)
  },
  async inspect() {
    return [...mockLoad().values()].map((f) => {
      const bad = hash(f.accountId).charCodeAt(0) % 10 === 0
      return { accountId: f.accountId, decision: bad ? ('reject' as const) : ('ok' as const), plan: f.plan, reason: bad ? 'unauthorized' : 'ok' }
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
// cpamp HTTP 报错对外统一中性文案（§8）：绝不把 cpamp 状态码/响应体/内部 API 路径透传前端。
// 原文只进服务端日志（console.error）供排查——响应体是 cpamp **返回**的，不含我们**发出**的
// RT/管理密钥/CDK（密钥在 Authorization 头、RT 在上传件里，都不在响应体）。
export const CPA_UNAVAILABLE = '账号服务暂时不可用，请稍后重试'
async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method, headers: authHeaders(), cache: 'no-store' }
  if (body !== undefined) {
    init.headers = authHeaders({ 'Content-Type': 'application/json' })
    init.body = JSON.stringify(body)
  }
  const res = await fetch(api(path), init)
  const text = await res.text()
  if (!res.ok) {
    // 原文（状态码 + 响应体 + 内部路径）只进服务端日志，对外抛中性常量（§8）
    console.error(`[cpa] ${method} ${path} ${res.status}`, text)
    throw new Error(CPA_UNAVAILABLE)
  }
  return text ? JSON.parse(text) : {}
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
    //   claude —— account（P0-A 实测，无 account_id）；
    //   grok   —— sub（OIDC subject；P0-A 扒 CLIProxyAPI xai 源码确认为稳定唯一标识，跨重授权稳定）。
    // account_id/accountId 最优先；也绝不用 claude 的 id 字段（那非稳定业务 ID，会把唯一键锚错）。
    accountId:
      f.account_id ??
      f.accountId ??
      (provider === 'claude' ? f.account : undefined) ??
      (provider === 'grok' ? f.sub : undefined) ??
      '',
    email: f.email ?? '',
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
    await req('POST', '/v0/management/oauth-callback', { provider: CPA_PROVIDER[provider], redirect_url: redirectUrl })
    if (state) {
      for (let i = 0; i < 15; i++) {
        const s = await getAuthStatus(state)
        if (s.status === 'ok') break
        if (s.status === 'error') {
          if (s.error) console.error('[cpa] get-auth-status error', s.error) // cpamp 原文留服务端排查，不透传（§8）
          throw new Error('授权失败')
        }
        await sleep(1000)
      }
    }
    return findNew(this, provider, known, before)
  },

  async checkOAuth(provider, state, knownAccountIds, before) {
    const s = await getAuthStatus(state)
    if (s.status === 'error') {
      if (s.error) console.error('[cpa] get-auth-status error', s.error) // cpamp 原文留服务端排查，不透传（§8）
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
    const res = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: OPENAI_CLIENT_ID, refresh_token: rt, scope: 'openid profile email offline_access' }),
    })
    if (!res.ok) throw new Error(`Refresh Token 无效或已过期（${res.status}）`)
    const tok = (await res.json()) as { access_token: string; id_token: string; refresh_token?: string }
    const { accountId, email } = parseIdToken(tok.id_token)
    if (!accountId) throw new Error('无法从令牌解析账号信息')
    if (known.has(accountId)) return { accountId, email, plan: 'unknown', authFileName: '', duplicate: true }
    const authFile = {
      type: 'codex', id_token: tok.id_token, access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? rt, account_id: accountId, email, last_refresh: new Date().toISOString(),
    }
    const fileName = `codex-${accountId}.json`
    const form = new FormData()
    form.append('file', new Blob([JSON.stringify(authFile)], { type: 'application/json' }), fileName)
    const up = await fetch(api('/v0/management/auth-files'), { method: 'POST', headers: authHeaders(), body: form })
    if (!up.ok) {
      // cpamp 上传响应原文只进服务端日志，对外抛中性常量（§8）。响应体不含我们上传的 RT/token。
      console.error(`[cpa] POST /v0/management/auth-files ${up.status}`, await up.text())
      throw new Error(CPA_UNAVAILABLE)
    }
    return { accountId, email, plan: 'unknown', authFileName: fileName, duplicate: false }
  },

  async listAuthFiles() {
    const data = (await req('GET', '/v0/management/auth-files')) as { files?: RawFile[] }
    return (data.files ?? []).map(normFile)
  },
  async setDisabled(name, disabled) {
    await req('PATCH', '/v0/management/auth-files/status', { name, disabled })
  },
  async deleteAuthFile(name) {
    await req('DELETE', `/v0/management/auth-files?name=${encodeURIComponent(name)}`)
  },
  async inspect() {
    const run = (await req('POST', '/v0/management/codex-inspection/run', {})) as { run?: { id?: number } }
    const id = run.run?.id
    if (!id) return []
    let detail: { run?: { status?: string }; results?: RawInspectionResult[] } = {}
    for (let i = 0; i < 30; i++) {
      detail = (await req('GET', `/v0/management/codex-inspection/runs/${id}`)) as typeof detail
      if (detail.run?.status === 'completed' || detail.results) break
      await sleep(1000)
    }
    return (detail.results ?? []).map(mapInspection)
  },
  async getDailyUsage() {
    // ⚠️ 骨架（同 inspect）：真实 usage 事件字段名 / hub 来源标记格式 / 是否支持查询参数缩小范围
    //   待对接样本核对，MOCK 阶段以 mockClient 验证聚合逻辑。数据源 GET /v0/management/usage（P0-A 实探）：
    //   { apis: { [端点]: { models: { [模型]: { details: RawUsageDetail[] } } } } }，每条 detail = 一次请求。
    // 计量口径（§3.1/P0-A）：按 (auth_provider_snapshot, account_snapshot) 分组、timestamp 落自然日、
    //   数 details 条数 = 该号当日调用次数；只算带 hub 来源标记（auth_label_snapshot）的贡献号。
    const data = (await req('GET', '/v0/management/usage')) as RawUsage
    const agg = new Map<string, DailyUsage>() // key = provider\0accountId\0date
    for (const apiEntry of Object.values(data.apis ?? {})) {
      for (const model of Object.values(apiEntry?.models ?? {})) {
        for (const d of model?.details ?? []) {
          // TODO(对接)：hub 来源标记格式待定——只算贡献号（见 isHubContribution）。来源标记写入见后续单。
          if (!isHubContribution(d.auth_label_snapshot)) continue
          const provider = providerFromToken(d.auth_provider_snapshot) // anthropic→claude、xai→grok
          const accountId = d.account_snapshot ?? ''
          const ts = d.timestamp
          if (!provider || !accountId || ts == null) continue // 认不出 provider / 无稳定号 / 无时间戳 → 跳过
          const date = dayStr(tsToMs(ts))
          const key = `${provider}\0${accountId}\0${date}`
          const cur = agg.get(key)
          if (cur) cur.count++
          else agg.set(key, { accountId, provider, date, count: 1 })
        }
      }
    }
    return [...agg.values()]
  },
}

interface RawInspectionResult {
  accountId?: string; disabled?: boolean; status?: string; action?: string
  actionReason?: string; statusCode?: number | null; isQuota?: boolean; planType?: string; errorKind?: string
}
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
  else if (code === 200 || r.action === 'enable' || r.action === 'keep' || !r.errorKind) decision = 'ok'
  else decision = 'retry'
  return { accountId: r.accountId ?? '', decision, plan, reason }
}

// —— usage 事件流原始形状（P2-R2 骨架，字段名待对接样本核对，见 getDailyUsage 注释）——
interface RawUsageDetail {
  account_snapshot?: string
  auth_provider_snapshot?: string
  auth_label_snapshot?: string
  timestamp?: string | number
}
interface RawUsage {
  apis?: Record<string, { models?: Record<string, { details?: RawUsageDetail[] }> }>
}
// TODO(对接)：hub 来源标记的确切格式待 usage 样本核对。占位实现——label 含 'hub' 视为贡献号。
// ⚠️ 真实对接前必以样本校准：误纳官方号→错发分、漏纳贡献号→少发分（同 mapInspection 的 reason 词表纪律）。
// ⚠️ label 预过滤已降级为「优化提示」而非硬闸（codex xhigh 于 PR #16 指出：现今没有任何收号路径写
// label——RT 上传无 label 字段、OAuth 只提交 provider+redirect_url，硬过滤＝生产零发分）。真正的
// 「是不是我们的号」由 settle 层的 pooled 号索引判定（(provider, account_id) 匹配，权威）；此处仅当
// label **明确是别家标记**时跳过（现阶段一律放行）。「来源标记写入」已立项（路线图 P2 残项），写入
// 落地 + 真实 label 格式核对后，可把这里升级回预过滤以省聚合量。
function isHubContribution(_label: string | undefined): boolean {
  return true // 放行；归属判定交给 settle 层 pooled 索引
}
// TODO(对接)：timestamp 单位待核对。占位启发式——数字 <1e12 视为秒、否则毫秒；字符串按 Date.parse。
function tsToMs(ts: string | number): number {
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts
  return Date.parse(ts) || 0
}

export const cpa: CpaClient = env.mock ? mockClient : realClient
