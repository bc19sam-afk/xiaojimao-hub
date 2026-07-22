// ============================================================================
// 只读探测真实 cpamp —— 核对 lib/cpa.ts realClient 的占位字段假设（probe-cpamp-real-R1）
//
// 运行（须真实密钥 + Tailscale 起）：
//   MOCK=false SESSION_SECRET=probe-only-dummy-secret-0000000000000 \
//     node --env-file=.env.local scripts/probe-cpamp.ts
//   （SESSION_SECRET 仅为过 lib/env.ts 的 fail-fast 校验塞的哑值——只用于会话 cookie 签名，
//    与只读 CPA 调用无关；不是真密钥、不入库。MOCK=false 才走 realClient 打真实网络。）
//
// 🔴 只读红线：本脚本只发 HTTP GET（rawGet 里 method 写死 'GET'）。绝不 POST/PATCH/PUT/DELETE，
//    绝不调 setDisabled/deleteAuthFile/ingest*/*OAuth/inspect 等任何有写副作用的方法，绝不改任何号状态。
// 🔴 脱敏红线（§8）：RT/access_token/id_token/管理密钥/完整 account_id/邮箱绝不进日志——
//    所有值经 safe() 递归掩码后才打印（account/sub→前4后2、email→x***@domain、token 类→<redacted>）。
//
// 接线：用 Node 内置 TS（v26），带扩展名导入 lib（与 scripts/backup.ts 一致），tsconfig 已排除 scripts。
// ============================================================================

// —— 脱敏工具（whitelist 优先：默认倾向 redact，宁可漏看不可泄露）————————————————
function maskId(s: unknown): string {
  if (typeof s !== 'string' || !s) return String(s)
  if (s.length <= 8) return `${s.slice(0, 1)}…(${s.length} chars)`
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`
}
function maskEmail(s: unknown): string {
  if (typeof s !== 'string' || !s) return String(s)
  const at = s.indexOf('@')
  if (at < 1) return maskId(s)
  return `${s.slice(0, 1)}***${s.slice(at)}`
}
function maskFilename(s: unknown): string {
  if (typeof s !== 'string' || !s) return String(s)
  const dot = s.lastIndexOf('.')
  const ext = dot > 0 ? s.slice(dot) : ''
  const base = ext ? s.slice(0, -ext.length) : s
  const dash = base.indexOf('-')
  if (dash < 0) return `${maskId(base)}${ext}`
  // 保留 provider 前缀（探测文件名模式的关键），只掩码后半的 id 段
  return `${base.slice(0, dash + 1)}${maskId(base.slice(dash + 1))}${ext}`
}
function maskLabel(s: unknown): string {
  if (s === '' ) return '(empty string)'
  if (typeof s !== 'string') return String(s)
  // 只暴露「结构特征」：前 3 字符 + 长度 + 是否含 'hub'（isHubContribution 的占位判据）
  return `${JSON.stringify(s.slice(0, 3))}… (len=${s.length}, containsHub=${/hub/i.test(s)})`
}

const REDACT_K = /token|secret|password|passwd|authorization|bearer|refresh|access|jwt|cookie|credential|private|signature|apikey|api_key|_key$|^key$|mgmt|management/i
const TS_K = /(^|_)(timestamp|ts|time|date|created_at|updated_at|last_refresh|expires?)($|_|s$)/i
const EMAIL_K = /email/i
const NAME_K = /^(name|filename|file)$/i
const LABEL_K = /label/i
const ID_K = /^(account|account_id|accountid|account_snapshot|sub|chatgpt_account_id|user_id|userid|uid|id)$/i
const PROV_K = /provider|^type$/i

// 递归清洗任意值为「可安全打印」形态：字段名（= schema，非敏感）保留，值按 key 语义掩码/脱敏。
// 未知的长字符串（>20）一律 redact 作兜底安全网（可能是 token）。数组采样前若干条以控体积。
function safe(val: unknown, key = '', arrCap = 5): unknown {
  if (val === null || val === undefined) return val
  if (Array.isArray(val)) {
    const head = val.slice(0, arrCap).map((v) => safe(v, key, arrCap))
    return val.length > arrCap ? [...head, `…(+${val.length - arrCap} more, total ${val.length})`] : head
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(val as Record<string, unknown>)) {
      out[k] = safe((val as Record<string, unknown>)[k], k, arrCap)
    }
    return out
  }
  const kl = key.toLowerCase()
  // 优先级：redact 安全网 → 时间戳（非敏感、需看单位）→ email → 文件名 → label → id → provider/type → 长串兜底 redact → 原值
  if (REDACT_K.test(kl)) return '<redacted>'
  if (TS_K.test(kl)) return val // 时间戳/日期原值：核对单位（秒/毫秒/ISO）用，非敏感
  if (typeof val === 'string') {
    if (EMAIL_K.test(kl)) return maskEmail(val)
    if (NAME_K.test(kl)) return maskFilename(val)
    if (LABEL_K.test(kl)) return maskLabel(val)
    if (ID_K.test(kl)) return maskId(val)
    if (PROV_K.test(kl)) return val.length <= 24 ? val : maskId(val) // provider/type 枚举原值（anthropic/codex/xai）
    if (val.length > 20) return '<redacted:long-string>' // 未知长串兜底：可能是 token
    return val
  }
  return val // number / boolean：原值
}

function line(label: string, v: unknown) {
  console.log(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
}
function section(title: string) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

// timestamp 单位判定（对照 lib/cpa.ts tsToMs 启发式：数字 <1e12→秒、否则毫秒；字符串 Date.parse）
function tsVerdict(ts: unknown): string {
  if (typeof ts === 'number') {
    const kind = ts < 1e12 ? '秒(→*1000)' : '毫秒(原值)'
    const asMs = ts < 1e12 ? ts * 1000 : ts
    let iso = '?'
    try { iso = new Date(asMs).toISOString() } catch { /* ignore */ }
    return `number=${ts} → 判定 ${kind} → ${iso}`
  }
  if (typeof ts === 'string') {
    const p = Date.parse(ts)
    return `string(ISO?) len=${ts.length} → Date.parse ${Number.isNaN(p) ? '失败(NaN)' : '成功→' + new Date(p).toISOString()}`
  }
  return `其它类型: ${typeof ts}`
}

// —— 只读 HTTP GET（method 写死，无法发写请求）+ 20s 超时 ————————————————————————
async function rawGet(baseUrl: string, key: string, path: string): Promise<{ ok: boolean; status: number; json?: unknown; text?: string; err?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'GET', // 🔴 写死 GET，绝不改
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json: unknown
    try { json = text ? JSON.parse(text) : {} } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, json, text: json === undefined ? text : undefined }
  } catch (e) {
    return { ok: false, status: 0, err: (e as Error)?.name === 'AbortError' ? 'TIMEOUT(20s)' : `${(e as Error)?.name}: ${(e as Error)?.message}` }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  process.env.MOCK = 'false' // 钉死 realClient（在 import lib/env.ts 求值之前）

  const baseUrl = (process.env.CPA_BASE_URL || '').replace(/\/+$/, '')
  const key = process.env.CPA_MANAGEMENT_KEY || ''
  if (!baseUrl || !key) {
    console.error('[probe] 缺 CPA_BASE_URL / CPA_MANAGEMENT_KEY。请：MOCK=false SESSION_SECRET=<32+chars> node --env-file=.env.local scripts/probe-cpamp.ts')
    process.exit(2)
  }
  // baseUrl 也脱敏打印（host 可能是 Tailscale 内网名，非密钥但无需外泄）
  let host = baseUrl
  try { host = new URL(baseUrl).host } catch { /* ignore */ }
  console.log(`[probe] target host: ${maskId(host)}  (MOCK=false, 只读 GET 探测)`)

  // ---- 第一步：连通性自检（只发一个只读 GET）----
  section('① 连通性自检  GET /v0/management/auth-files')
  const probe0 = await rawGet(baseUrl, key, '/v0/management/auth-files')
  if (!probe0.ok) {
    console.error(`[probe] ❌ 连通性失败：status=${probe0.status} err=${probe0.err ?? ''}`)
    console.error('[probe] 症状判读：0/TIMEOUT/ENOTFOUND/ECONNREFUSED → 疑 Tailscale 未起或地址变；401/403 → 疑管理密钥失效/权限。')
    console.error('[probe] 按红线：不硬重试轰炸、不猜。连通性未通过 = 本轮结论，其余项标「未探测」。')
    process.exit(1)
  }
  console.log(`[probe] ✓ 连通 status=${probe0.status}`)

  // ---- ② auth-files 结构 + provider 识别 ----
  section('② auth-files 原始结构 + provider 识别（对照 normFile cpa.ts:257 / listAuthFiles :413）')
  const raw0 = probe0.json as Record<string, unknown> | unknown[]
  const isArr = Array.isArray(raw0)
  console.log(`  顶层类型: ${isArr ? 'Array（⚠️ 代码假设 {files:[...]}）' : 'Object'}`)
  if (!isArr) console.log(`  顶层键: ${JSON.stringify(Object.keys(raw0 as object))}  （代码读 .files —— 见 cpa.ts:414）`)
  const files: unknown[] = isArr ? (raw0 as unknown[]) : ((raw0 as Record<string, unknown>).files as unknown[]) ?? []
  console.log(`  文件数: ${Array.isArray(files) ? files.length : '非数组!'}`)
  if (Array.isArray(files) && files.length) {
    // 全体文件的字段名并集（schema 全貌）
    const keyUnion = new Set<string>()
    for (const f of files) if (f && typeof f === 'object') Object.keys(f).forEach((k) => keyUnion.add(k))
    console.log(`  文件对象字段名并集: ${JSON.stringify([...keyUnion])}`)
    console.log('  —— 逐文件脱敏 dump（找 claude 号看其 type/provider/name 前缀 & 稳定 ID 字段）——')
    files.slice(0, 15).forEach((f, i) => console.log(`  [file#${i}] ${JSON.stringify(safe(f))}`))
    if (files.length > 15) console.log(`  …(+${files.length - 15} more)`)
  }

  // 跑高层 cpa.listAuthFiles()（= normFile 归一后）——确认 provider/accountId 识别对 claude 号是否奏效
  section('②b cpa.listAuthFiles() 归一结果（normFile 识别得对不对）')
  try {
    const { cpa } = await import('../lib/cpa.ts')
    const norm = await cpa.listAuthFiles()
    console.log(`  归一后条数: ${norm.length}`)
    const byProv: Record<string, number> = {}
    for (const f of norm) byProv[String(f.provider)] = (byProv[String(f.provider)] ?? 0) + 1
    console.log(`  provider 分布（undefined=识别失败）: ${JSON.stringify(byProv)}`)
    norm.slice(0, 15).forEach((f, i) =>
      console.log(`  [norm#${i}] provider=${f.provider} accountId=${maskId(f.accountId)} name=${maskFilename(f.name)} email=${maskEmail(f.email)} plan=${f.plan} disabled=${f.disabled}`),
    )
  } catch (e) {
    console.error(`  ⚠️ cpa.listAuthFiles() 抛错（可能 normFile 或 env）: ${(e as Error)?.message}`)
  }

  // ---- ③ usage 事件结构 + 稳定 ID + timestamp + label ----
  section('③ usage 原始结构（对照 getDailyUsage cpa.ts:435-461 / RawUsage :494）  GET /v0/management/usage')
  const uRes = await rawGet(baseUrl, key, '/v0/management/usage')
  if (!uRes.ok) {
    console.error(`  ⚠️ usage 拉取失败 status=${uRes.status} err=${uRes.err ?? ''} —— 标「未探测」`)
  } else {
    const u = uRes.json as Record<string, unknown>
    const topKeys = u && typeof u === 'object' ? Object.keys(u) : []
    console.log(`  顶层键: ${JSON.stringify(topKeys)}  （代码假设有 .apis —— 见 cpa.ts:441/443）`)
    const apis = (u?.apis ?? undefined) as Record<string, unknown> | undefined
    if (!apis) {
      console.log('  ⚠️ 无 .apis 键 —— 层级与代码假设不符，dump 顶层脱敏结构探真实形状：')
      console.log(`  ${JSON.stringify(safe(u), null, 0).slice(0, 1500)}`)
    } else {
      const apiKeys = Object.keys(apis)
      console.log(`  apis 端点键(${apiKeys.length}): ${JSON.stringify(apiKeys.slice(0, 8))}${apiKeys.length > 8 ? ' …' : ''}`)
      // 遍历采样：收集 details 字段名并集 / provider 枚举 / label 样例 / timestamp 样例 / account 样例
      const detailKeys = new Set<string>()
      const provs = new Set<string>()
      const labels: string[] = []
      const tsSamples: unknown[] = []
      const acctSamples: string[] = []
      let totalDetails = 0
      let sawModelsLayer = false
      let firstDetailDump: unknown = null
      for (const apiEntry of Object.values(apis)) {
        const models = (apiEntry as Record<string, unknown>)?.models as Record<string, unknown> | undefined
        if (models) sawModelsLayer = true
        const modelObjs = models ? Object.values(models) : [apiEntry] // 若无 models 层，退一步看 apiEntry 自身
        for (const m of modelObjs) {
          const details = (m as Record<string, unknown>)?.details as unknown[] | undefined
          if (!Array.isArray(details)) continue
          totalDetails += details.length
          for (const d of details) {
            if (!d || typeof d !== 'object') continue
            if (!firstDetailDump) firstDetailDump = d
            const dr = d as Record<string, unknown>
            Object.keys(dr).forEach((k) => detailKeys.add(k))
            // 按代码假设的字段名取样（真实若不同，会体现在「字段名并集」里）
            const prov = dr.auth_provider_snapshot ?? dr.provider ?? dr.auth_provider
            if (typeof prov === 'string' && provs.size < 10) provs.add(prov)
            const lab = dr.auth_label_snapshot ?? dr.label ?? dr.auth_label
            if (lab !== undefined && labels.length < 6) labels.push(maskLabel(lab))
            const ts = dr.timestamp ?? dr.ts ?? dr.time
            if (ts !== undefined && tsSamples.length < 4) tsSamples.push(ts)
            const acc = dr.account_snapshot ?? dr.account ?? dr.account_id
            if (typeof acc === 'string' && acctSamples.length < 4) acctSamples.push(maskId(acc))
          }
        }
      }
      console.log(`  存在 models 中间层: ${sawModelsLayer}  （代码假设 apis[端点].models[模型].details[] —— cpa.ts:443-445）`)
      console.log(`  details 总数(采样内): ${totalDetails}`)
      console.log(`  detail 字段名并集: ${JSON.stringify([...detailKeys])}`)
      console.log(`    ↳ 代码读的字段名(cpa.ts:448-450): account_snapshot / auth_provider_snapshot / auth_label_snapshot / timestamp`)
      if (firstDetailDump) console.log(`  首条 detail 脱敏 dump: ${JSON.stringify(safe(firstDetailDump))}`)
      console.log(`\n  ③-provider(稳定 provider 值, anthropic→claude): ${JSON.stringify([...provs])}`)
      console.log(`  ③-account 稳定 ID 样例(脱敏): ${JSON.stringify(acctSamples)}  （claude 稳定 ID 代码取 account_snapshot）`)
      console.log(`  ④-timestamp 单位判定:`)
      tsSamples.forEach((t, i) => console.log(`     [ts#${i}] ${tsVerdict(t)}`))
      console.log(`  ⑤-label 样例(脱敏, isHubContribution 占位判据=含'hub'): ${JSON.stringify(labels)}`)
    }
  }

  // 跑高层 cpa.getDailyUsage()（确认聚合能否跑通 / 是否返回空）
  section('③b cpa.getDailyUsage() 聚合结果（能否跑通 / 返回条数）')
  try {
    const { cpa } = await import('../lib/cpa.ts')
    const usage = await cpa.getDailyUsage()
    console.log(`  聚合后条数: ${usage.length}`)
    usage.slice(0, 10).forEach((r, i) =>
      console.log(`  [usage#${i}] provider=${r.provider} accountId=${maskId(r.accountId)} date=${r.date} count=${r.count}`),
    )
    if (usage.length === 0) console.log('  （0 条：可能无带 hub 标记的贡献号调用，或字段名/层级不符——见 ③ 原始结构判读）')
  } catch (e) {
    console.error(`  ⚠️ cpa.getDailyUsage() 抛错: ${(e as Error)?.message}`)
  }

  // ---- ⑥ config（若只读可得）----
  section('⑥ config（若存在且只读）  GET /v0/management/config')
  const cRes = await rawGet(baseUrl, key, '/v0/management/config')
  if (!cRes.ok) {
    console.log(`  status=${cRes.status} err=${cRes.err ?? ''} —— 若 404/405 则无此只读端点或非 GET；标「未核/不适用」`)
  } else {
    console.log(`  status=${cRes.status} 顶层脱敏结构:`)
    console.log(`  ${JSON.stringify(safe(cRes.json), null, 0).slice(0, 1800)}`)
  }

  section('探测结束（全程只读 GET，全部输出已脱敏）')
}

main().catch((e) => {
  console.error('[probe] fatal:', (e as Error)?.message ?? e)
  process.exit(1)
})
