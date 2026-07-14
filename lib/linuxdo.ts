import { env, redirectUri } from './env'

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

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const basic = Buffer.from(
    `${env.linuxdo.clientId}:${env.linuxdo.clientSecret}`,
  ).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  })
  const res = await fetch(env.linuxdo.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${basic}`,
    },
    body,
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`linuxdo token exchange failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

export async function fetchLinuxDoUser(accessToken: string): Promise<LinuxDoUser> {
  const res = await fetch(env.linuxdo.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`linuxdo userinfo failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}
