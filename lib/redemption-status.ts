export type RedemptionStatusKey = 'pending' | 'failed' | 'fulfilled' | 'unknown'

export interface RedemptionStatusView {
  key: RedemptionStatusKey
  label: string
  symbol: string
  description: string
}

const STATUS_VIEWS: Record<RedemptionStatusKey, RedemptionStatusView> = {
  pending: {
    key: 'pending',
    label: '处理中',
    symbol: '…',
    description: '兑换请求正在处理',
  },
  failed: {
    key: 'failed',
    label: '兑换失败',
    symbol: '!',
    description: '本次兑换未完成',
  },
  fulfilled: {
    key: 'fulfilled',
    label: '已完成',
    symbol: '✓',
    description: '兑换已完成',
  },
  unknown: {
    key: 'unknown',
    label: '状态未知',
    symbol: '?',
    description: '暂时无法确认兑换状态',
  },
}

export function redemptionStatusView(status: unknown): RedemptionStatusView {
  if (status === 'pending' || status === 'failed' || status === 'fulfilled') return STATUS_VIEWS[status]
  return STATUS_VIEWS.unknown
}
