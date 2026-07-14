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

export interface CpaClient {
  startOAuth(provider: ProviderId): Promise<StartResult>
  // redirect 流程：提交回调 URL 完成
  finishOAuth(provider: ProviderId, redirectUrl: string, knownAccountIds: string[]): Promise<IngestResult>
  // device 流程：轮询一次，ok 则落号
  checkOAuth(provider: ProviderId, state: string, knownAccountIds: string[]): Promise<CheckResult>
  // 直贴 RT（仅 codex）
  ingestRefreshToken(rt: string, knownAccountIds: string[]): Promise<IngestResult>
  listAuthFiles(): Promise<AuthFile[]>
  setDisabled(name: string, disabled: boolean): Promise<void>
  deleteAuthFile(name: string): Promise<void>
  inspect(): Promise<ProbeResult[]>
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
const MOCK_CPA_PATH = join(process.cwd(), 'data', 'mock-cpa.json')
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
function mockCreate(provider: ProviderId, seed: string): IngestResult {
  const store = mockLoad()
  const accountId = `acct_${hash(seed)}`
  const authFileName = `${provider}-${accountId}.json`
  if (store.has(authFileName)) return { accountId, email: '', plan: MOCK_PLAN[provider], authFileName, duplicate: true }
  const email = `${provider}_${hash(seed).slice(0, 6)}@example.com`
  store.set(authFileName, { name: authFileName, accountId, email, plan: MOCK_PLAN[provider], disabled: true })
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
  async finishOAuth(provider) {
    return mockCreate(provider, provider + Math.random())
  },
  async checkOAuth(provider) {
    // mock：直接当作已授权，造号
    return { status: 'ok', ingest: mockCreate(provider, provider + Math.random()) }
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
async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method, headers: authHeaders(), cache: 'no-store' }
  if (body !== undefined) {
    init.headers = authHeaders({ 'Content-Type': 'application/json' })
    init.body = JSON.stringify(body)
  }
  const res = await fetch(api(path), init)
  const text = await res.text()
  if (!res.ok) throw new Error(`CPA ${method} ${path} 失败: ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

interface RawFile {
  name?: string; filename?: string
  account_id?: string; accountId?: string
  email?: string; plan?: string; planType?: string; disabled?: boolean
}
function normFile(f: RawFile): AuthFile {
  return {
    name: f.name ?? f.filename ?? '',
    accountId: f.account_id ?? f.accountId ?? '',
    email: f.email ?? '',
    plan: f.plan ?? f.planType ?? 'unknown',
    disabled: Boolean(f.disabled),
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
// 授权完成后，找出新落的号（accountId 不在已知集合）
async function findNew(client: CpaClient, known: Set<string>): Promise<IngestResult> {
  const files = await client.listAuthFiles()
  const created = files.find((f) => f.accountId && !known.has(f.accountId))
  if (!created) return { accountId: '', email: '', plan: 'unknown', authFileName: '', duplicate: true }
  return { accountId: created.accountId, email: created.email, plan: created.plan, authFileName: created.name, duplicate: false }
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

  async finishOAuth(provider, redirectUrl, knownAccountIds) {
    const known = new Set(knownAccountIds)
    let state = ''
    try {
      state = new URL(redirectUrl).searchParams.get('state') ?? ''
    } catch {
      throw new Error('回调链接格式不对，请粘贴完整的地址栏 URL')
    }
    await req('POST', '/v0/management/oauth-callback', { provider: CPA_PROVIDER[provider], redirect_url: redirectUrl })
    if (state) {
      for (let i = 0; i < 15; i++) {
        const s = await getAuthStatus(state)
        if (s.status === 'ok') break
        if (s.status === 'error') throw new Error(s.error || '授权失败')
        await sleep(1000)
      }
    }
    return findNew(this, known)
  },

  async checkOAuth(provider, state, knownAccountIds) {
    void provider
    const s = await getAuthStatus(state)
    if (s.status === 'error') return { status: 'error', error: s.error || '授权失败' }
    if (s.status !== 'ok') return { status: 'wait' }
    const ingest = await findNew(this, new Set(knownAccountIds))
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
    if (!up.ok) throw new Error(`上传账号失败: ${up.status} ${(await up.text()).slice(0, 200)}`)
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
}

interface RawInspectionResult {
  accountId?: string; disabled?: boolean; status?: string; action?: string
  actionReason?: string; statusCode?: number | null; isQuota?: boolean; planType?: string; errorKind?: string
}
function mapInspection(r: RawInspectionResult): ProbeResult {
  const code = r.statusCode ?? 0
  const plan = (r.planType || 'unknown').toLowerCase()
  const reason = r.actionReason || r.errorKind || r.status || ''
  let decision: ProbeDecision
  if (r.isQuota || code === 402 || code === 429) decision = 'retry'
  else if (code === 401 || r.errorKind === 'invalidated' || r.action === 'delete') decision = 'reject'
  else if (r.action === 'reauth' || r.errorKind === 'reauth') decision = 'reauth'
  else if (code === 200 || r.action === 'enable' || r.action === 'keep' || !r.errorKind) decision = 'ok'
  else decision = 'retry'
  return { accountId: r.accountId ?? '', decision, plan, reason }
}

export const cpa: CpaClient = env.mock ? mockClient : realClient
