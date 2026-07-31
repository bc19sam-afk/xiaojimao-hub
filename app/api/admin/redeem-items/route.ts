import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { getAdminActor } from '@/lib/admin'
import { parsePositiveSafeInteger } from '@/lib/admin-input'
import { db } from '@/lib/db'
import { auditRedeemItemUpsert, auditRedeemItemDelete } from '@/lib/audit'

const REDEEM_ITEM_SAVE_FAILURE = {
  ok: false,
  code: 'REDEEM_ITEM_SAVE_FAILED',
  error: '保存兑换项失败，请重试',
} as const

const REDEEM_ITEM_INVALID = {
  ok: false,
  code: 'REDEEM_ITEM_INVALID',
  error: '商品信息不完整',
} as const

const REDEEM_ITEM_INVALID_ID = {
  ok: false,
  code: 'REDEEM_ITEM_INVALID_ID',
  error: '商品 ID 无效',
} as const

const REDEEM_ITEM_NOT_FOUND = {
  ok: false,
  code: 'REDEEM_ITEM_NOT_FOUND',
  error: '兑换项不存在或已被删除',
} as const

const IDEMPOTENCY_KEY_REQUIRED = {
  ok: false,
  code: 'IDEMPOTENCY_KEY_REQUIRED',
  error: '新增请求缺少幂等标识，请重新编辑后再试',
} as const

const IDEMPOTENCY_KEY_INVALID = {
  ok: false,
  code: 'IDEMPOTENCY_KEY_INVALID',
  error: '新增请求幂等标识无效，请重新编辑后再试',
} as const

const IDEMPOTENCY_KEY_CONFLICT = {
  ok: false,
  code: 'IDEMPOTENCY_KEY_CONFLICT',
  error: '该新增请求与已提交内容不一致，请重新编辑后再试',
} as const

const REDEEM_ITEM_DELETE_FAILURE = {
  ok: false,
  code: 'REDEEM_ITEM_DELETE_FAILED',
  error: '删除兑换项失败，请重试',
} as const

type RedeemItemInput = {
  id?: number
  name: string
  description: string
  cost: number
  kind: string
  enabled: boolean
  sort: number
  config: string
  fulfillment?: 'placeholder' | 'cdk'
  perUserLimit?: number
}

class RedeemItemNotFoundError extends Error {}
class IdempotencyConflictError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRedeemItemInput(value: unknown):
  | { ok: true; item: RedeemItemInput }
  | { ok: false; invalidId: boolean } {
  if (!isRecord(value)) return { ok: false, invalidId: false }
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id')
  if (hasId && (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0)) {
    return { ok: false, invalidId: true }
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return { ok: false, invalidId: false }
  }
  if (typeof value.kind !== 'string' || value.kind.trim().length === 0) {
    return { ok: false, invalidId: false }
  }
  if (typeof value.cost !== 'number' || !Number.isSafeInteger(value.cost) || value.cost < 0) {
    return { ok: false, invalidId: false }
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    return { ok: false, invalidId: false }
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return { ok: false, invalidId: false }
  }
  if (value.sort !== undefined && (typeof value.sort !== 'number' || !Number.isSafeInteger(value.sort))) {
    return { ok: false, invalidId: false }
  }
  if (
    value.fulfillment !== undefined &&
    value.fulfillment !== 'cdk' &&
    value.fulfillment !== 'placeholder'
  ) {
    return { ok: false, invalidId: false }
  }
  if (
    value.perUserLimit !== undefined &&
    (typeof value.perUserLimit !== 'number' || !Number.isSafeInteger(value.perUserLimit) || value.perUserLimit < 0)
  ) {
    return { ok: false, invalidId: false }
  }
  let config = '{}'
  if (typeof value.config === 'string') config = value.config
  else if (value.config !== undefined) config = JSON.stringify(value.config)

  return {
    ok: true,
    item: {
      id: hasId ? value.id as number : undefined,
      name: value.name,
      description: value.description ?? '',
      cost: value.cost,
      kind: value.kind,
      enabled: value.enabled !== false,
      sort: value.sort ?? 0,
      config,
      fulfillment: value.fulfillment as RedeemItemInput['fulfillment'],
      perUserLimit: value.perUserLimit as number | undefined,
    },
  }
}

function createPayloadHash(item: RedeemItemInput): string {
  return createHash('sha256').update(JSON.stringify({
    name: item.name,
    description: item.description,
    cost: item.cost,
    kind: item.kind,
    enabled: item.enabled,
    sort: item.sort,
    config: item.config,
    fulfillment: item.fulfillment ?? 'placeholder',
    perUserLimit: item.perUserLimit ?? 0,
  })).digest('hex')
}

function mutationResponse() {
  return {
    redeemItems: db.listRedeemItems(false),
    overview: db.adminOverview(),
  }
}

// 新增/更新兑换项
export async function PUT(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', error: '无权限' }, { status: 403 })
  }
  const parsed = parseRedeemItemInput(await req.json().catch(() => null))
  if (!parsed.ok) {
    if (parsed.invalidId) return NextResponse.json(REDEEM_ITEM_INVALID_ID, { status: 400 })
    return NextResponse.json(REDEEM_ITEM_INVALID, { status: 400 })
  }
  const next = parsed.item
  try {
    const result = next.id
      ? db.withTransaction(() => {
          // Update is an explicit branch: missing/invalid IDs never fall through to INSERT.
          const old = db.getRedeemItem(next.id!)
          if (!old) throw new RedeemItemNotFoundError()
          if (db.upsertRedeemItem(next) !== next.id) throw new RedeemItemNotFoundError()
          const saved = db.getRedeemItem(next.id!)
          if (!saved) throw new RedeemItemNotFoundError()
          db.recordAudit(actor, auditRedeemItemUpsert(old, {
            ...saved,
            enabled: saved.enabled === 1,
          }))
          return mutationResponse()
        })
      : (() => {
          const requestKey = req.headers.get('idempotency-key')?.trim() ?? ''
          if (!requestKey) return NextResponse.json(IDEMPOTENCY_KEY_REQUIRED, { status: 400 })
          if (!/^[A-Za-z0-9._:-]{16,128}$/.test(requestKey)) {
            return NextResponse.json(IDEMPOTENCY_KEY_INVALID, { status: 400 })
          }
          const payloadHash = createPayloadHash(next)
          return db.withTransaction(() => {
            const existing = db.getRedeemItemCreateRequest(requestKey)
            if (existing) {
              if (existing.payloadHash !== payloadHash || !db.getRedeemItem(existing.itemId)) {
                throw new IdempotencyConflictError()
              }
              return mutationResponse()
            }

            const itemId = db.upsertRedeemItem(next)
            if (!itemId) throw new Error('redeem item insert failed')
            const saved = db.getRedeemItem(itemId)
            if (!saved) throw new Error('redeem item readback failed')
            db.recordAudit(actor, auditRedeemItemUpsert(undefined, {
              ...saved,
              enabled: saved.enabled === 1,
            }))
            db.recordRedeemItemCreateRequest({
              requestKey,
              payloadHash,
              itemId,
              createdAt: Date.now(),
            })
            return mutationResponse()
          })
        })()
    if (result instanceof NextResponse) return result
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof RedeemItemNotFoundError) {
      return NextResponse.json(REDEEM_ITEM_NOT_FOUND, { status: 404 })
    }
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json(IDEMPOTENCY_KEY_CONFLICT, { status: 409 })
    }
    console.error('[admin] redeem item save failed', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json(REDEEM_ITEM_SAVE_FAILURE, { status: 500 })
  }
}

// 删除兑换项
export async function DELETE(req: NextRequest) {
  const actor = await getAdminActor()
  if (!actor) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const id = parsePositiveSafeInteger(new URL(req.url).searchParams.get('id'))
  if (id === null) return NextResponse.json(REDEEM_ITEM_INVALID_ID, { status: 400 })
  try {
    const result = db.withTransaction(() => {
      const old = db.getRedeemItem(id)
      if (!old || !db.deleteRedeemItem(id)) throw new RedeemItemNotFoundError()
      db.recordAudit(actor, auditRedeemItemDelete(old, id))
      return {
        redeemItems: db.listRedeemItems(false),
        overview: db.adminOverview(),
      }
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof RedeemItemNotFoundError) {
      return NextResponse.json(REDEEM_ITEM_NOT_FOUND, { status: 404 })
    }
    console.error('[admin] redeem item delete failed', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json(REDEEM_ITEM_DELETE_FAILURE, { status: 500 })
  }
}
