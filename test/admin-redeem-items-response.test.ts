import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAdminRedeemItemsResponse } from '../lib/admin-redeem-items-response.ts'

const validItem = {
  id: 1,
  name: '测试商品',
  description: '说明',
  cost: 10,
  kind: 'timed_quota',
  enabled: 1,
  sort: 0,
  config: '{}',
  fulfillment: 'placeholder',
  perUserLimit: 0,
}

const validOverview = {
  pooledAccounts: 2,
  needsReview: 1,
  pendingRedemptions: 3,
  enabledRedeemItems: 4,
}

test('admin redeem item success response accepts only complete canonical item and overview shapes', () => {
  assert.deepEqual(parseAdminRedeemItemsResponse({
    ok: true,
    redeemItems: [validItem],
    overview: validOverview,
  }), {
    redeemItems: [validItem],
    overview: validOverview,
  })
})

test('admin redeem item success response rejects null, missing, wrong, unsafe, and mixed item rows', async (t) => {
  const invalidRows: Array<[string, unknown]> = [
    ['null row', null],
    ['missing required field', { ...validItem, config: undefined }],
    ['wrong field type', { ...validItem, enabled: '1' }],
    ['NaN numeric field', { ...validItem, cost: Number.NaN }],
    ['negative numeric field', { ...validItem, perUserLimit: -1 }],
    ['unsafe integer field', { ...validItem, id: Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid enabled range', { ...validItem, enabled: 2 }],
    ['invalid fulfillment', { ...validItem, fulfillment: 'internal' }],
  ]

  for (const [name, row] of invalidRows) {
    await t.test(name, () => {
      assert.equal(parseAdminRedeemItemsResponse({
        ok: true,
        redeemItems: [row],
        overview: validOverview,
      }), null)
    })
  }

  assert.equal(parseAdminRedeemItemsResponse({
    ok: true,
    redeemItems: [validItem, null],
    overview: validOverview,
  }), null, '合法/非法混合数组必须整体拒绝，不能部分写入客户端状态')
})

test('admin redeem item success response rejects incomplete or out-of-range overview values', () => {
  for (const overview of [
    null,
    { ...validOverview, needsReview: undefined },
    { ...validOverview, pooledAccounts: '2' },
    { ...validOverview, pendingRedemptions: Number.NaN },
    { ...validOverview, enabledRedeemItems: -1 },
    { ...validOverview, needsReview: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(parseAdminRedeemItemsResponse({
      ok: true,
      redeemItems: [validItem],
      overview,
    }), null)
  }
})
