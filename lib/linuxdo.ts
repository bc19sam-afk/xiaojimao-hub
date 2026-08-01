import { env, redirectUri } from './env'
import {
  invalidOutboundShape,
  outboundJson,
  OutboundRequestError,
} from './outbound-http'

export interface LinuxDoUser {
  id: number
  username: string
  name?: string
  trust_level?: number
  avatar_url?: string
  avatar_template?: string
  active?: boolean
  [k: string]: unknown
}

export function buildAuthorizeUrl(state: string): string {
  const u = new URL(env.linuxdo.authorizeUrl)
  u.searchParams.set('client_id', env.linuxdo.clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', 'user')
  u.searchParams.set('state', state)
  return u.toString()
}

interface TokenResponse {
  access_token: string
  token_type?: string
  [k: string]: unknown
}

export const LINUXDO_UNAVAILABLE = 'Linux.do 登录服务暂时不可用，请稍后重试'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const basic = Buffer.from(
    `${env.linuxdo.clientId}:${env.linuxdo.clientSecret}`,
  ).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  })
  let raw: unknown
  try {
    raw = await outboundJson(
      env.linuxdo.tokenUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Authorization: `Basic ${basic}`,
        },
        body,
        cache: 'no-store',
      },
      { service: 'linuxdo', operation: 'token_exchange' },
    )
  } catch (error) {
    if (error instanceof OutboundRequestError) throw new Error(LINUXDO_UNAVAILABLE)
    throw error
  }
  const value = asRecord(raw)
  if (!value || typeof value.access_token !== 'string' || !value.access_token.trim()) {
    invalidOutboundShape('linuxdo', 'token_exchange')
  }
  return {
    access_token: value.access_token.trim(),
    token_type: typeof value.token_type === 'string' ? value.token_type : undefined,
  }
}

export async function fetchLinuxDoUser(accessToken: string): Promise<LinuxDoUser> {
  let raw: unknown
  try {
    raw = await outboundJson(
      env.linuxdo.userinfoUrl,
      {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        cache: 'no-store',
      },
      { service: 'linuxdo', operation: 'userinfo' },
    )
  } catch (error) {
    if (error instanceof OutboundRequestError) throw new Error(LINUXDO_UNAVAILABLE)
    throw error
  }
  const value = asRecord(raw)
  const trust = value?.trust_level
  // Linux.do 官方 OIDC discovery 声明 userinfo 支持 username/active/trust_level 等 claims：
  // https://connect.linux.do/.well-known/openid-configuration
  // 本项目再按既有持久身份契约要求正整数 id；真实接入前由 release checklist 的真登录验收确认。
  const valid =
    value !== null &&
    typeof value.id === 'number' &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.username === 'string' &&
    value.username.trim().length > 0 &&
    typeof trust === 'number' &&
    Number.isSafeInteger(trust) &&
    trust >= 0 &&
    value.active !== false &&
    (value.active === undefined || typeof value.active === 'boolean') &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.avatar_url === undefined || typeof value.avatar_url === 'string') &&
    (value.avatar_template === undefined || typeof value.avatar_template === 'string')
  if (!valid) invalidOutboundShape('linuxdo', 'userinfo')

  return {
    id: value.id as number,
    username: (value.username as string).trim(),
    trust_level: trust as number,
    active: value.active as boolean | undefined,
    name: value.name as string | undefined,
    avatar_url: value.avatar_url as string | undefined,
    avatar_template: value.avatar_template as string | undefined,
  }
}
