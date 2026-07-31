export interface AdminRedeemItem {
  id: number
  name: string
  description: string
  cost: number
  kind: string
  enabled: 0 | 1
  sort: number
  config: string
  fulfillment: 'placeholder' | 'cdk'
  perUserLimit: number
}

export interface AdminOverviewResponse {
  pooledAccounts: number
  needsReview: number
  pendingRedemptions: number
  enabledRedeemItems: number
}

export interface AdminRedeemItemsResponse {
  redeemItems: AdminRedeemItem[]
  overview: AdminOverviewResponse
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0
}

export function isAdminRedeemItem(value: unknown): value is AdminRedeemItem {
  if (!isRecord(value)) return false
  return (
    isSafeInteger(value.id) && value.id > 0 &&
    typeof value.name === 'string' && value.name.trim().length > 0 &&
    typeof value.description === 'string' &&
    isNonNegativeSafeInteger(value.cost) &&
    typeof value.kind === 'string' && value.kind.trim().length > 0 &&
    (value.enabled === 0 || value.enabled === 1) &&
    isSafeInteger(value.sort) &&
    typeof value.config === 'string' &&
    (value.fulfillment === 'placeholder' || value.fulfillment === 'cdk') &&
    isNonNegativeSafeInteger(value.perUserLimit)
  )
}

export function isAdminOverviewResponse(value: unknown): value is AdminOverviewResponse {
  if (!isRecord(value)) return false
  return (
    isNonNegativeSafeInteger(value.pooledAccounts) &&
    isNonNegativeSafeInteger(value.needsReview) &&
    isNonNegativeSafeInteger(value.pendingRedemptions) &&
    isNonNegativeSafeInteger(value.enabledRedeemItems)
  )
}

export function parseAdminRedeemItemsResponse(value: unknown): AdminRedeemItemsResponse | null {
  if (!isRecord(value) || value.ok !== true) return null
  if (!Array.isArray(value.redeemItems) || !value.redeemItems.every(isAdminRedeemItem)) return null
  if (!isAdminOverviewResponse(value.overview)) return null
  return { redeemItems: value.redeemItems, overview: value.overview }
}
