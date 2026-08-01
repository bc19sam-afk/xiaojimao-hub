export type OAuthErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PROVIDER'
  | 'AUTH_REQUIRED'
  | 'PROVIDER_BUSY'
  | 'OPERATION_BUSY'
  | 'TRANSITION_CONFLICT'
  | 'DUPLICATE_ACCOUNT'
  | 'OAUTH_SESSION_INVALID'
  | 'OAUTH_CANCELLED'
  | 'UPSTREAM_AUTH_REJECTED'
  | 'CPA_UNAVAILABLE'

interface OAuthErrorDefinition {
  status: number
  message: string
  retryable: boolean
  retryAfterMs?: number
}

const ERROR_DEFINITIONS: Record<OAuthErrorCode, OAuthErrorDefinition> = {
  INVALID_REQUEST: { status: 400, message: '请求参数不正确', retryable: false },
  UNSUPPORTED_PROVIDER: { status: 400, message: '不支持的账号类型', retryable: false },
  AUTH_REQUIRED: { status: 401, message: '请先登录', retryable: false },
  PROVIDER_BUSY: {
    status: 409,
    message: '该类型已有授权正在进行，请稍后再试',
    retryable: true,
    retryAfterMs: 3000,
  },
  OPERATION_BUSY: {
    status: 409,
    message: '授权会话正在处理中，请稍后重试',
    retryable: true,
    retryAfterMs: 3000,
  },
  TRANSITION_CONFLICT: {
    status: 409,
    message: '授权会话正在完成，暂时无法取消',
    retryable: true,
    retryAfterMs: 1000,
  },
  DUPLICATE_ACCOUNT: { status: 409, message: '这个账号已贡献过', retryable: false },
  OAUTH_SESSION_INVALID: { status: 410, message: '授权会话无效或已过期', retryable: false },
  OAUTH_CANCELLED: { status: 410, message: '授权会话已取消', retryable: false },
  UPSTREAM_AUTH_REJECTED: {
    status: 422,
    message: '授权未完成或已被拒绝，请重新发起',
    retryable: false,
  },
  CPA_UNAVAILABLE: {
    status: 503,
    message: '账号服务暂时不可用，请稍后重试',
    retryable: true,
    retryAfterMs: 3000,
  },
}

export interface OAuthSessionView {
  provider: 'codex' | 'claude' | 'grok'
  state: string
  url: string
  flow: 'redirect' | 'device'
  userCode?: string
  expiresAt: number
}

export class OAuthProtocolError extends Error {
  readonly code: OAuthErrorCode

  constructor(code: OAuthErrorCode) {
    super(ERROR_DEFINITIONS[code].message)
    this.name = 'OAuthProtocolError'
    this.code = code
  }
}

export function oauthProtocolError(code: OAuthErrorCode): OAuthProtocolError {
  return new OAuthProtocolError(code)
}

export function isOAuthProtocolError(error: unknown): error is OAuthProtocolError {
  return error instanceof OAuthProtocolError
}

export function oauthFailure(code: OAuthErrorCode): {
  status: number
  body: {
    ok: false
    error: {
      code: OAuthErrorCode
      message: string
      retryable: boolean
      retryAfterMs?: number
    }
  }
} {
  const definition = ERROR_DEFINITIONS[code]
  return {
    status: definition.status,
    body: {
      ok: false,
      error: {
        code,
        message: definition.message,
        retryable: definition.retryable,
        ...(definition.retryAfterMs === undefined ? {} : { retryAfterMs: definition.retryAfterMs }),
      },
    },
  }
}

export function oauthPending(): {
  status: 202
  body: { ok: true; status: 'pending'; retryAfterMs: 3000 }
} {
  return { status: 202, body: { ok: true, status: 'pending', retryAfterMs: 3000 } }
}

export function oauthClientDisposition(code: OAuthErrorCode): 'clear' | 'retain' {
  switch (code) {
    case 'PROVIDER_BUSY':
    case 'OPERATION_BUSY':
    case 'TRANSITION_CONFLICT':
    case 'CPA_UNAVAILABLE':
      return 'retain'
    default:
      return 'clear'
  }
}

export function shouldClearOAuthSession(code: OAuthErrorCode): boolean {
  return oauthClientDisposition(code) === 'clear'
}

export function oauthErrorCode(error: unknown, fallback: OAuthErrorCode): OAuthErrorCode {
  if (isOAuthProtocolError(error)) return error.code
  if (error && typeof error === 'object' && 'oauthTerminal' in error) {
    if ((error as { oauthTerminal?: unknown }).oauthTerminal === true) return 'UPSTREAM_AUTH_REJECTED'
  }
  if (error instanceof Error && error.message === ERROR_DEFINITIONS.CPA_UNAVAILABLE.message) {
    return 'CPA_UNAVAILABLE'
  }
  return fallback
}
