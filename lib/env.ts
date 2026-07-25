// ============================================================================
// 环境配置 + 启动期校验（fail-fast）
//
// 原则：所有地址/密钥只从 env 读，切生产只改 .env，代码不动。
// 安全：非 mock 环境缺强随机会话密钥、或缺 CPA 配置，直接拒绝启动。
// ============================================================================

const mock = (process.env.MOCK ?? 'true') !== 'false'

// 会话密钥：生产必须是强随机（>=32 字符）。缺失/过短时——
//   mock 本地开发：允许临时密钥（告警）；
//   非 mock：拒绝启动。
function resolveSessionSecret(): string {
  const s = process.env.SESSION_SECRET
  if (s && s.length >= 32) return s
  if (mock) {
    if (!s) {
      console.warn(
        '[env] 未设 SESSION_SECRET，mock 模式使用临时密钥（切勿用于生产：openssl rand -hex 32）',
      )
    }
    return s || 'mock-only-insecure-secret-do-not-use-in-production'
  }
  throw new Error(
    '[env] 生产环境必须设置强随机 SESSION_SECRET（>=32 字符，例如 `openssl rand -hex 32`）；当前缺失或过短，已拒绝启动。',
  )
}

// dead-man 心跳地址（P6-R2，可选）：worker 每轮全成后 ping 一次，外部服务（healthchecks.io /
// uptime-kuma）在约定时间内没收到就告警——单机规模够用，不上 Prometheus。
// 缺省空＝关闭。设了但不是 http(s) 开头＝配错，警告一次并按关闭处理（不拒绝启动：告警通道配错
// 不该拖垮收号主链路，且这是可选增强项）。
function resolveHeartbeatUrl(): string {
  const raw = (process.env.HEARTBEAT_URL || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//.test(raw)) {
    // 🔴 §8：只说「格式不对」，绝不把配错的值回显到日志（可能含 uuid 型密钥）
    console.warn('[env] HEARTBEAT_URL 不是 http:// 或 https:// 开头，已按未配置处理（心跳关闭）')
    return ''
  }
  return raw
}

// CPA 配置：非 mock 时必须齐全，否则拒绝启动。
function resolveCpa() {
  const baseUrl = (process.env.CPA_BASE_URL || '').replace(/\/+$/, '')
  const managementKey = process.env.CPA_MANAGEMENT_KEY || ''
  if (!mock && (!baseUrl || !managementKey)) {
    throw new Error(
      '[env] MOCK=false 时必须配置 CPA_BASE_URL 和 CPA_MANAGEMENT_KEY，已拒绝启动。',
    )
  }
  return { baseUrl, managementKey }
}

export const env = {
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  sessionSecret: resolveSessionSecret(),
  mock,
  linuxdo: {
    clientId: process.env.LINUXDO_CLIENT_ID || '',
    clientSecret: process.env.LINUXDO_CLIENT_SECRET || '',
    authorizeUrl: process.env.LINUXDO_AUTHORIZE_URL || 'https://connect.linux.do/oauth2/authorize',
    tokenUrl: process.env.LINUXDO_TOKEN_URL || 'https://connect.linux.do/oauth2/token',
    userinfoUrl: process.env.LINUXDO_USERINFO_URL || 'https://connect.linux.do/api/user',
    minTrustLevel: Number(process.env.MIN_TRUST_LEVEL || '0'),
  },
  cpa: resolveCpa(),
  // 管理后台：管理密码 或 指定 Linux.do 管理员ID，任一满足即可进 /admin
  admin: {
    password: process.env.ADMIN_PASSWORD || '',
    linuxdoIds: (process.env.ADMIN_LINUXDO_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  },
  worker: {
    // 后台自动巡检开关。需常驻 Node 服务（next start 自托管），serverless 无效。
    enabled: (process.env.WORKER_ENABLED ?? 'true') !== 'false',
    // 巡检间隔（毫秒）。mock 下 8s 便于演示；真实对接 cpamp 时应放大到分钟级。
    intervalMs: Number(process.env.WORKER_INTERVAL_MS ?? '8000'),
    // dead-man 心跳地址（可选，空＝关闭）。见 resolveHeartbeatUrl。
    heartbeatUrl: resolveHeartbeatUrl(),
  },
}

// 生产应固定 APP_BASE_URL；仅当显式允许时才信任反代转发头推断 origin（见 lib/request.ts）
export const trustForwardedHeaders =
  (process.env.TRUST_FORWARDED_HEADERS ?? (mock ? 'true' : 'false')) === 'true'

export const redirectUri = `${env.appBaseUrl}/api/auth/linuxdo/callback`
