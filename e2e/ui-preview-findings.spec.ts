import { expect, test, type Page, type Route } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import net from 'node:net'
import os from 'node:os'
import { migrate } from '../lib/migrate'

const reviewRow = {
  id: 'review-ui-r1',
  linuxdoId: 1,
  username: 'preview',
  provider: 'grok',
  accountId: 'grok-preview-account',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
}

function withE2eDb<T>(run: (db: DatabaseSync) => T): T {
  const dbPath = process.env.XJM_UI_E2E_DB_PATH
  if (!dbPath) throw new Error('XJM_UI_E2E_DB_PATH 未设置')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  try {
    return run(db)
  } finally {
    db.close()
  }
}

function seedContribution(args: {
  id: string
  accountId: string
  username: string
  verifyStatus?: string
  pooledAt?: number | null
}) {
  const now = Date.now()
  withE2eDb((db) => {
    db.prepare('DELETE FROM contributions WHERE id=?').run(args.id)
    db.prepare(
      `INSERT INTO contributions
       (id, linuxdo_id, username, account_id, email, provider, plan, method, auth_file_name,
        verify_status, points, reward_status, reward_text, reward_note, reward_code, created_at, updated_at, pooled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      args.id,
      1,
      args.username,
      args.accountId,
      '',
      'grok',
      'supergrok-long-running-preview-plan',
      'oauth',
      `${args.id}.json`,
      args.verifyStatus ?? 'needs_review',
      0,
      'none',
      '',
      '',
      null,
      now,
      now,
      args.pooledAt ?? null,
    )
  })
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const done = (connected: boolean) => {
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(750, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function externalIpv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address)
}

async function login(page: Page) {
  await page.goto('/api/auth/dev-login')
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function openAdmin(page: Page) {
  await login(page)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: '管理后台', level: 1 })).toBeVisible()
}

async function waitForStableLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

async function mockReviewQueue(page: Page, onPost?: (route: Route) => Promise<void>) {
  await page.route('**/api/admin/review', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, review: [reviewRow] }) })
      return
    }
    if (onPost) {
      await onPost(route)
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, review: [] }) })
  })
}

test('provider options remain fully visible and keyboard operable at mobile and desktop widths', async ({ page }) => {
  test.setTimeout(60_000)

  const longAccount = `grok-realistic-${'very-long-account-segment-'.repeat(8)}tail`
  seedContribution({
    id: 'e2e-long-dashboard',
    accountId: longAccount,
    username: `preview_${'long_username_'.repeat(6)}`,
    verifyStatus: 'pooled',
    pooledAt: Date.now() - 86_400_000,
  })
  withE2eDb((db) => {
    db.prepare('DELETE FROM daily_settlements WHERE contribution_id=?').run('e2e-long-dashboard')
    db.prepare(
      `INSERT INTO daily_settlements
       (contribution_id, date, provider, account_id, call_count, points, settled_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('e2e-long-dashboard', '2026-07-27', 'grok', longAccount, 987_654_321, 123_456_789, Date.now())
    db.prepare("DELETE FROM point_ledger WHERE reason='usage' AND ref=?").run('usage:e2e-long-dashboard:2026-07-27')
    db.prepare(
      'INSERT INTO point_ledger (linuxdo_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)',
    ).run(1, 123_456_789, 'usage', 'usage:e2e-long-dashboard:2026-07-27', Date.now())
  })

  await login(page)

  for (const width of [320, 375, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await waitForStableLayout(page)

    const buttons = page.locator('[data-provider-option]')
    await expect(buttons).toHaveCount(3)
    const bounds = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width }
      }),
    )
    const providerSubtexts = [
      ['codex', 'ChatGPT', 'Plus / Pro / Team / K12'],
      ['claude', 'Claude', 'Claude 订阅'],
      ['grok', 'Grok', 'SuperGrok'],
    ] as const
    const pageWidth = await page.evaluate(() => document.documentElement.clientWidth)
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    const contributionsScroller = page.getByRole('table').locator('..')
    const scrollerBounds = await contributionsScroller.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }
    })

    expect(scrollWidth, `${width}px 页面不应横向溢出`).toBeLessThanOrEqual(pageWidth + 1)
    for (const rect of bounds) {
      expect(rect.width).toBeGreaterThan(0)
      expect(rect.left).toBeGreaterThanOrEqual(0)
      expect(rect.right).toBeLessThanOrEqual(pageWidth + 1)
    }
    for (const [id, name, subtext] of providerSubtexts) {
      const option = page.locator(`[data-provider-option="${id}"]`)
      await expect(option).toContainText(name)
      const sub = option.getByText(subtext, { exact: true })
      await expect(sub).toBeVisible()
      const subBounds = await sub.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }
      })
      expect(subBounds.left).toBeGreaterThanOrEqual(0)
      expect(subBounds.right).toBeLessThanOrEqual(pageWidth + 1)
      expect(subBounds.scrollWidth).toBeLessThanOrEqual(subBounds.clientWidth + 1)
    }
    expect(scrollerBounds.left).toBeGreaterThanOrEqual(0)
    expect(scrollerBounds.right).toBeLessThanOrEqual(pageWidth + 1)
    if (width === 320) expect(scrollerBounds.scrollWidth).toBeGreaterThan(scrollerBounds.clientWidth)
  }

  await expect(page.getByText(longAccount, { exact: true })).toBeVisible()

  const grok = page.getByRole('button', { name: 'Grok SuperGrok' })
  await grok.focus()
  await page.keyboard.press('Enter')
  await expect(grok).toHaveAttribute('aria-pressed', 'true')
})

test('Playwright web server listens only on loopback', async ({ request }) => {
  expect((await request.get('/login')).status()).toBe(200)
  const addresses = externalIpv4Addresses()
  expect(addresses.length, '运行环境应至少有一个非 loopback IPv4 用于验证监听边界').toBeGreaterThan(0)
  const reachable = []
  for (const address of addresses) {
    if (await canConnect(address, 3211)) reachable.push(address)
  }
  expect(reachable, `测试服务不应通过非 loopback 地址访问：${reachable.join(', ')}`).toEqual([])
})

test('real long CDK result reflows inside the dashboard at every mobile viewport', async ({ page }) => {
  test.setTimeout(60_000)
  const itemName = `真实长码商品-${Date.now()}`
  const longCode = `CDK-${'A'.repeat(500)}`
  const itemId = withE2eDb((db) => {
    const created = db.prepare(
      `INSERT INTO redeem_items
       (name, description, cost, kind, enabled, sort, config, fulfillment, per_user_limit)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(itemName, 'long code layout fixture', 10, 'timed_quota', 1, 999, '{}', 'cdk', 0)
    const id = Number(created.lastInsertRowid)
    db.prepare(
      'INSERT INTO cdk_codes (item_id, code, status, created_at) VALUES (?, ?, \'available\', ?)',
    ).run(id, longCode, Date.now())
    db.prepare(
      'INSERT INTO point_ledger (linuxdo_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)',
    ).run(1, 100, 'contribution', `e2e-long-cdk:${id}`, Date.now())
    return id
  })

  try {
    await page.setViewportSize({ width: 320, height: 900 })
    await login(page)
    const itemRow = page.getByText(itemName, { exact: true }).first().locator('../..')
    await expect(itemRow).toBeVisible()
    await itemRow.getByRole('button').click()

    const feedback = page.getByTestId('redeem-feedback')
    await expect(feedback).toContainText(`已兑换「${itemName}」`)
    const resultRow = page.getByTestId('redemption-record').filter({ hasText: itemName })
    const result = resultRow.getByTestId('redemption-copy-code')
    await expect(result).toBeVisible()

    for (const width of [320, 375, 390, 430, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await waitForStableLayout(page)
      const pageWidth = await page.evaluate(() => document.documentElement.clientWidth)
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(scrollWidth, `${width}px 长 CDK 页面不应横向溢出`).toBeLessThanOrEqual(pageWidth + 1)
      const resultBounds = await result.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }
      })
      expect(resultBounds.left).toBeGreaterThanOrEqual(0)
      expect(resultBounds.right).toBeLessThanOrEqual(pageWidth + 1)
      expect(resultBounds.scrollWidth).toBeLessThanOrEqual(resultBounds.clientWidth + 1)
    }
  } finally {
    withE2eDb((db) => {
      db.prepare("DELETE FROM point_ledger WHERE reason='redeem' AND ref IN (SELECT id FROM redemptions WHERE item_id=?)").run(itemId)
      db.prepare('DELETE FROM redemptions WHERE item_id=?').run(itemId)
      db.prepare('DELETE FROM cdk_codes WHERE item_id=?').run(itemId)
      db.prepare('DELETE FROM redeem_items WHERE id=?').run(itemId)
      db.prepare('DELETE FROM point_ledger WHERE ref=?').run(`e2e-long-cdk:${itemId}`)
    })
  }
})

test('delete actions and both review actions require confirmation; cancel and Escape send no request', async ({ page }) => {
  let mutations = 0
  await mockReviewQueue(page, async (route) => {
    mutations += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, review: [] }) })
  })
  for (const endpoint of ['point-rules', 'usage-rates', 'redeem-items']) {
    await page.route(`**/api/admin/${endpoint}*`, async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.fallback()
        return
      }
      mutations += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
  }

  await openAdmin(page)

  for (const name of [/删除发分规则/, /删除折算规则/, /删除兑换项/]) {
    const trigger = page.getByRole('button', { name }).first()
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  }

  const retry = page.getByRole('button', { name: /重试人工复核/ })
  await retry.click()
  const retryDialog = page.getByRole('dialog', { name: /确认重试/ })
  await expect(retryDialog.getByRole('button', { name: '取消' })).toBeFocused()
  await retryDialog.getByRole('button', { name: '取消' }).click()
  await expect(retry).toBeFocused()

  const terminate = page.getByRole('button', { name: /终止人工复核/ })
  await terminate.click()
  await expect(page.getByRole('dialog', { name: /确认终止/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(terminate).toBeFocused()
  expect(mutations).toBe(0)
})

test('confirmation submits once while pending and failed actions stay retryable', async ({ page }) => {
  let reviewPosts = 0
  let releaseReview!: () => void
  const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve })
  await mockReviewQueue(page, async (route) => {
    reviewPosts += 1
    await reviewGate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, review: [] }) })
  })
  let deletePosts = 0
  let releaseDelete!: () => void
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
  await page.route('**/api/admin/redeem-items*', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback()
      return
    }
    deletePosts += 1
    await deleteGate
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        code: 'REDEEM_ITEM_DELETE_FAILED',
        error: 'SQLITE path=/private/db.sqlite token=delete-secret stack=internal-host',
      }),
    })
  })

  await openAdmin(page)
  const failureItemName = `E2E retryable delete ${Date.now()}`
  const failureItemId = withE2eDb((db) => Number(db.prepare(
    `INSERT INTO redeem_items
     (name, description, cost, kind, enabled, sort, config, fulfillment, per_user_limit)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(failureItemName, 'failure focus fixture', 1, 'timed_quota', 1, 997, '{}', 'placeholder', 0).lastInsertRowid))
  await page.reload()

  try {
    await page.getByRole('button', { name: /终止人工复核/ }).click()
    const terminateDialog = page.getByRole('dialog', { name: /确认终止/ })
    const confirmTerminate = terminateDialog.getByTestId('confirm-action-button')
    await confirmTerminate.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect(confirmTerminate).toBeDisabled()
    expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true)
    releaseReview()
    await expect(terminateDialog).toBeHidden()
    expect(reviewPosts).toBe(1)

    const deleteTrigger = page.getByRole('button', { name: `删除兑换项 ${failureItemName}` })
    await deleteTrigger.click()
    const deleteDialog = page.getByRole('dialog', { name: /确认删除兑换项/ })
    const confirmDelete = deleteDialog.getByTestId('confirm-action-button')
    await confirmDelete.click()
    await expect(confirmDelete).toBeDisabled()
    expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true)
    releaseDelete()
    await expect(deleteDialog.getByRole('alert')).toHaveText('删除兑换项失败，请重试')
    await expect(deleteDialog.getByRole('alert')).toBeFocused()
    for (const secret of ['SQLITE path=', '/private/db.sqlite', 'delete-secret', 'internal-host']) {
      await expect(page.getByText(secret, { exact: false })).toHaveCount(0)
    }
    await expect(deleteDialog).toBeVisible()
    await expect(confirmDelete).toBeEnabled()
    await expect(deleteTrigger).toBeVisible()
    expect(deletePosts).toBe(1)
    await confirmDelete.click()
    await expect(deleteDialog.getByRole('alert')).toHaveText('删除兑换项失败，请重试')
    await expect(deleteDialog.getByRole('alert')).toBeFocused()
    expect(deletePosts).toBe(2)
  } finally {
    releaseReview()
    releaseDelete()
    withE2eDb((db) => db.prepare('DELETE FROM redeem_items WHERE id=?').run(failureItemId))
  }
})

test('dangerous action failures use public allowlisted messages and never echo API internals', async ({ page }) => {
  await mockReviewQueue(page, async (route) => {
    await route.fulfill({ status: 503, contentType: 'text/html', body: '<html>stack=/srv/app.db token=review-secret</html>' })
  })
  const dangerousRoutes = [
    ['point-rules', 'POINT_RULE_DELETE_FAILED', '删除发分规则', '删除发分规则失败，请重试', 'point-secret'],
    ['usage-rates', 'UNTRUSTED_INTERNAL_CODE', '删除折算规则', '删除折算规则失败，请重试', 'rate-secret'],
    ['redeem-items', 'UNTRUSTED_INTERNAL_CODE', '删除兑换项', '删除兑换项失败，请重试', 'item-secret'],
  ] as const
  for (const [endpoint, code, title, message, secret] of dangerousRoutes) {
    await page.route(`**/api/admin/${endpoint}*`, async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.fallback()
        return
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, code, error: `SQLITE path=/private/${secret}.db token=${secret} stack=internal-host` }),
      })
    })
  }

  await openAdmin(page)
  for (const [endpoint, _code, title, message] of dangerousRoutes) {
    const trigger = page.getByRole('button', { name: new RegExp(title) }).first()
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('confirm-action-button').click()
    await expect(dialog.getByRole('alert')).toHaveText(message)
    await expect(dialog.getByRole('alert')).toBeFocused()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()
    void endpoint
  }

  const reviewTrigger = page.getByRole('button', { name: /重试人工复核/ })
  await reviewTrigger.click()
  const reviewDialog = page.getByRole('dialog', { name: /确认重试/ })
  await reviewDialog.getByTestId('confirm-action-button').click()
  await expect(reviewDialog.getByRole('alert')).toHaveText('人工复核操作失败，请重试')
  await expect(reviewDialog.getByRole('alert')).toBeFocused()
  await reviewDialog.getByRole('button', { name: '取消' }).click()
  await expect(reviewDialog).toBeHidden()

  for (const secret of ['point-secret', 'rate-secret', 'item-secret', 'review-secret', '/private/']) {
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0)
  }
})

test('dangerous admin routes return fixed public JSON when SQLite operations fail', async ({ page }) => {
  await openAdmin(page)
  await expect(page.getByTestId('readiness-status')).toContainText('可用')
  const suffix = Date.now()
  const cases = [
    {
      table: 'point_rules',
      broken: `__e2e_point_rules_${suffix}`,
      request: () => page.request.delete('/api/admin/point-rules?id=1'),
      body: { ok: false, code: 'POINT_RULE_DELETE_FAILED', error: '删除发分规则失败，请重试' },
    },
    {
      table: 'usage_rates',
      broken: `__e2e_usage_rates_${suffix}`,
      request: () => page.request.delete('/api/admin/usage-rates?id=1'),
      body: { ok: false, code: 'USAGE_RATE_DELETE_FAILED', error: '删除折算规则失败，请重试' },
    },
    {
      table: 'redeem_items',
      broken: `__e2e_redeem_items_${suffix}`,
      request: () => page.request.delete('/api/admin/redeem-items?id=1'),
      body: { ok: false, code: 'REDEEM_ITEM_DELETE_FAILED', error: '删除兑换项失败，请重试' },
    },
    {
      table: 'contributions',
      broken: `__e2e_contributions_${suffix}`,
      request: () => page.request.post('/api/admin/review', { data: { id: 'not-present', action: 'retry' } }),
      body: { ok: false, code: 'REVIEW_ACTION_FAILED', error: '人工复核操作失败，请重试' },
    },
  ]

  for (const entry of cases) {
    withE2eDb((db) => db.exec(`ALTER TABLE "${entry.table}" RENAME TO "${entry.broken}"`))
    try {
      const response = await entry.request()
      expect(response.status()).toBe(500)
      expect(response.headers()['content-type']).toContain('application/json')
      const body = await response.json()
      expect(body).toEqual(entry.body)
      const serialized = JSON.stringify(body)
      for (const internal of [entry.table, process.cwd(), 'SQLITE', 'stack', 'token=']) {
        expect(serialized).not.toContain(internal)
      }
    } finally {
      withE2eDb((db) => db.exec(`ALTER TABLE "${entry.broken}" RENAME TO "${entry.table}"`))
    }
  }

  // Audit failure must not turn a committed delete into a retryable half-success.
  const brokenAudit = `__e2e_audit_log_${suffix}`
  const protectedRuleId = withE2eDb((db) =>
    (db.prepare('SELECT id FROM point_rules ORDER BY id LIMIT 1').get() as { id: number }).id,
  )
  withE2eDb((db) => db.exec(`ALTER TABLE audit_log RENAME TO "${brokenAudit}"`))
  try {
    const response = await page.request.delete(`/api/admin/point-rules?id=${protectedRuleId}`)
    expect(response.status()).toBe(500)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'POINT_RULE_DELETE_FAILED',
      error: '删除发分规则失败，请重试',
    })
  } finally {
    withE2eDb((db) => db.exec(`ALTER TABLE "${brokenAudit}" RENAME TO audit_log`))
  }
  expect(withE2eDb((db) => db.prepare('SELECT id FROM point_rules WHERE id=?').get(protectedRuleId))).toEqual({
    id: protectedRuleId,
  })
})

test('successful delete, retry, and terminate use exact targets, persist audit state, and restore stable focus', async ({ page }) => {
  await openAdmin(page)

  const itemName = `E2E focus item ${Date.now()}`
  const created = await page.evaluate(async (name) => {
    const response = await fetch('/api/admin/redeem-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: 'isolated UI test item',
        cost: 1,
        kind: 'timed_quota',
        enabled: true,
        sort: 999,
        fulfillment: 'placeholder',
        perUserLimit: 0,
      }),
    })
    return await response.json()
  }, itemName)
  const itemId = Number(created.redeemItems.find((item: { name: string }) => item.name === itemName)?.id)
  expect(itemId).toBeGreaterThan(0)
  await page.reload()

  const deleteRequestPromise = page.waitForRequest((request) =>
    request.method() === 'DELETE' && request.url().includes('/api/admin/redeem-items?'))
  await page.getByRole('button', { name: `删除兑换项 ${itemName}` }).click()
  const deleteDialog = page.getByRole('dialog', { name: /确认删除兑换项/ })
  await deleteDialog.getByTestId('confirm-action-button').click()
  const deleteRequest = await deleteRequestPromise
  expect(new URL(deleteRequest.url()).searchParams.get('id')).toBe(String(itemId))
  await expect(deleteDialog).toBeHidden()
  await expect(page.getByRole('heading', { name: '兑换项（商店）', level: 2 })).toBeFocused()

  const deleted = withE2eDb((db) => ({
    item: db.prepare('SELECT id FROM redeem_items WHERE id=?').get(itemId),
    audit: db.prepare(
      "SELECT action, target FROM audit_log WHERE action='redeem_item.delete' ORDER BY id DESC LIMIT 1",
    ).get() as { action: string; target: string },
  }))
  expect(deleted.item).toBeUndefined()
  expect(deleted.audit).toEqual({ action: 'redeem_item.delete', target: `item#${itemId}(${itemName})` })

  const retryId = 'e2e-review-retry-focus'
  const terminateId = 'e2e-review-terminate-focus'
  const retryAccount = 'grok-retry-focus-account'
  const terminateAccount = 'grok-terminate-focus-account'
  seedContribution({ id: retryId, accountId: retryAccount, username: 'preview-retry' })
  seedContribution({ id: terminateId, accountId: terminateAccount, username: 'preview-terminate' })
  await page.reload()

  const retryRequestPromise = page.waitForRequest((request) =>
    request.method() === 'POST' && request.url().endsWith('/api/admin/review'))
  await page.getByRole('button', { name: `重试人工复核 grok ${retryAccount}` }).click()
  const retryDialog = page.getByRole('dialog', { name: /确认重试人工复核/ })
  await retryDialog.getByTestId('confirm-action-button').click()
  const retryRequest = await retryRequestPromise
  expect(retryRequest.postDataJSON()).toEqual({ id: retryId, action: 'retry' })
  await expect(retryDialog).toBeHidden()
  await expect(page.getByRole('heading', { name: '待人工复核', level: 2 })).toBeFocused()

  const retried = withE2eDb((db) => ({
    status: (db.prepare('SELECT verify_status AS status FROM contributions WHERE id=?').get(retryId) as { status: string }).status,
    audit: db.prepare(
      "SELECT action, target, new_value AS newValue FROM audit_log WHERE action='contribution.retry' ORDER BY id DESC LIMIT 1",
    ).get() as { action: string; target: string; newValue: string },
  }))
  expect(retried.status).toBe('submitted')
  expect(retried.audit.action).toBe('contribution.retry')
  expect(retried.audit.target).toBe(`grok/contribution#${retryId}`)
  expect(retried.audit.newValue).toContain('submitted')

  const terminateRequestPromise = page.waitForRequest((request) =>
    request.method() === 'POST' && request.url().endsWith('/api/admin/review'))
  await page.getByRole('button', { name: `终止人工复核 grok ${terminateAccount}` }).click()
  const terminateDialog = page.getByRole('dialog', { name: /确认终止人工复核/ })
  await terminateDialog.getByTestId('confirm-action-button').click()
  const terminateRequest = await terminateRequestPromise
  expect(terminateRequest.postDataJSON()).toEqual({ id: terminateId, action: 'terminate' })
  await expect(terminateDialog).toBeHidden()
  await expect(page.getByRole('heading', { name: '待人工复核', level: 2 })).toBeFocused()

  const terminated = withE2eDb((db) => ({
    status: (db.prepare('SELECT verify_status AS status FROM contributions WHERE id=?').get(terminateId) as { status: string }).status,
    audit: db.prepare(
      "SELECT action, target, new_value AS newValue FROM audit_log WHERE action='contribution.terminate' ORDER BY id DESC LIMIT 1",
    ).get() as { action: string; target: string; newValue: string },
  }))
  expect(terminated.status).toBe('stopped')
  expect(terminated.audit.action).toBe('contribution.terminate')
  expect(terminated.audit.target).toBe(`grok/contribution#${terminateId}`)
  expect(terminated.audit.newValue).toContain('stopped')
})

test('successful point-rule and usage-rate deletes use exact IDs, DB state, audit, and stable focus', async ({ page }) => {
  await openAdmin(page)
  const plan = `e2e-delete-${Date.now()}`
  const created = await page.evaluate(async (planName) => {
    const ruleResponse = await fetch('/api/admin/point-rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'grok', plan: planName, points: 17, label: 'E2E delete rule', enabled: true }),
    })
    const rateResponse = await fetch('/api/admin/usage-rates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'grok', plan: planName, pointsPerCall: 1.7, label: 'E2E delete rate', enabled: true }),
    })
    return { rule: await ruleResponse.json(), rate: await rateResponse.json() }
  }, plan)
  const ruleId = Number(created.rule.pointRules.find((row: { provider: string; plan: string }) => row.provider === 'grok' && row.plan === plan)?.id)
  const rateId = Number(created.rate.usageRates.find((row: { provider: string; plan: string }) => row.provider === 'grok' && row.plan === plan)?.id)
  expect(ruleId).toBeGreaterThan(0)
  expect(rateId).toBeGreaterThan(0)

  try {
    await page.reload()
    const ruleRequestPromise = page.waitForRequest((request) =>
      request.method() === 'DELETE' && request.url().includes('/api/admin/point-rules?'))
    await page.getByRole('button', { name: `删除发分规则 grok ${plan}` }).click()
    const ruleDialog = page.getByRole('dialog', { name: /确认删除发分规则/ })
    await ruleDialog.getByTestId('confirm-action-button').click()
    const ruleRequest = await ruleRequestPromise
    expect(new URL(ruleRequest.url()).searchParams.get('id')).toBe(String(ruleId))
    await expect(ruleDialog).toBeHidden()
    await expect(page.getByRole('heading', { name: '发分规则', level: 2 })).toBeFocused()
    const deletedRule = withE2eDb((db) => ({
      row: db.prepare('SELECT id FROM point_rules WHERE id=?').get(ruleId),
      audit: db.prepare(
        "SELECT action, target FROM audit_log WHERE action='point_rule.delete' AND target=? ORDER BY id DESC LIMIT 1",
      ).get(`grok/${plan}`) as { action: string; target: string },
    }))
    expect(deletedRule.row).toBeUndefined()
    expect(deletedRule.audit).toEqual({ action: 'point_rule.delete', target: `grok/${plan}` })

    const rateRequestPromise = page.waitForRequest((request) =>
      request.method() === 'DELETE' && request.url().includes('/api/admin/usage-rates?'))
    await page.getByRole('button', { name: `删除折算规则 grok ${plan}` }).click()
    const rateDialog = page.getByRole('dialog', { name: /确认删除折算规则/ })
    await rateDialog.getByTestId('confirm-action-button').click()
    const rateRequest = await rateRequestPromise
    expect(new URL(rateRequest.url()).searchParams.get('id')).toBe(String(rateId))
    await expect(rateDialog).toBeHidden()
    await expect(page.getByRole('heading', { name: '折算规则（按次单价）', level: 2 })).toBeFocused()
    const deletedRate = withE2eDb((db) => ({
      row: db.prepare('SELECT id FROM usage_rates WHERE id=?').get(rateId),
      audit: db.prepare(
        "SELECT action, target FROM audit_log WHERE action='usage_rate.delete' AND target=? ORDER BY id DESC LIMIT 1",
      ).get(`grok/${plan}`) as { action: string; target: string },
    }))
    expect(deletedRate.row).toBeUndefined()
    expect(deletedRate.audit).toEqual({ action: 'usage_rate.delete', target: `grok/${plan}` })
  } finally {
    withE2eDb((db) => {
      db.prepare('DELETE FROM point_rules WHERE id=?').run(ruleId)
      db.prepare('DELETE FROM usage_rates WHERE id=?').run(rateId)
    })
  }
})

test('saving an item updates the enabled-item overview from the persisted database state', async ({ page }) => {
  await openAdmin(page)
  const item = withE2eDb((db) => db.prepare(
    'SELECT id, name FROM redeem_items WHERE enabled=1 ORDER BY id LIMIT 1',
  ).get() as { id: number; name: string })
  const before = withE2eDb((db) => (db.prepare(
    'SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1',
  ).get() as { n: number }).n)
  const overviewValue = page.getByText('已启用商品', { exact: true }).locator('..').locator('dd')
  const row = page.locator(`input[value="${item.name}"]`).locator('..')

  try {
    await expect(overviewValue).toHaveText(String(before))
    await row.locator('input[type="checkbox"]').uncheck()
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/admin/redeem-items'))
    await row.getByRole('button', { name: '保存' }).click()
    expect((await responsePromise).status()).toBe(200)

    await expect(overviewValue).toHaveText(String(before - 1))
    const persisted = withE2eDb((db) => ({
      enabled: (db.prepare('SELECT enabled FROM redeem_items WHERE id=?').get(item.id) as { enabled: number }).enabled,
      count: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1').get() as { n: number }).n,
    }))
    expect(persisted).toEqual({ enabled: 0, count: before - 1 })
  } finally {
    withE2eDb((db) => db.prepare('UPDATE redeem_items SET enabled=1 WHERE id=?').run(item.id))
  }
})

test('deleting an item applies the DELETE overview and ignores a stale config refresh', async ({ page }) => {
  await openAdmin(page)
  const itemName = `E2E DELETE overview ${Date.now()}`
  const created = await page.evaluate(async (name) => {
    const response = await fetch('/api/admin/redeem-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: 'delete overview fixture', cost: 1, kind: 'timed_quota', enabled: true, sort: 998 }),
    })
    return await response.json()
  }, itemName)
  const itemId = Number(created.redeemItems.find((item: { name: string }) => item.name === itemName)?.id)
  expect(itemId).toBeGreaterThan(0)
  await page.reload()
  const before = withE2eDb((db) => (db.prepare(
    'SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1',
  ).get() as { n: number }).n)
  const overviewValue = page.getByText('已启用商品', { exact: true }).locator('..').locator('dd')
  await expect(overviewValue).toHaveText(String(before))

  let staleConfigCalls = 0
  await page.route('**/api/admin/config', async (route) => {
    staleConfigCalls += 1
    const response = await route.fetch()
    const body = await response.json()
    body.overview.enabledRedeemItems = before
    await route.fulfill({ response, body: JSON.stringify(body) })
  })

  try {
    const deleteRequestPromise = page.waitForRequest((request) =>
      request.method() === 'DELETE' && request.url().includes('/api/admin/redeem-items?'))
    await page.getByRole('button', { name: `删除兑换项 ${itemName}` }).click()
    const dialog = page.getByRole('dialog', { name: /确认删除兑换项/ })
    await dialog.getByTestId('confirm-action-button').click()
    const request = await deleteRequestPromise
    expect(new URL(request.url()).searchParams.get('id')).toBe(String(itemId))
    await expect(dialog).toBeHidden()
    await expect(overviewValue).toHaveText(String(before - 1))
    expect(staleConfigCalls).toBe(0)
    expect(withE2eDb((db) => ({
      item: db.prepare('SELECT id FROM redeem_items WHERE id=?').get(itemId),
      count: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1').get() as { n: number }).n,
    }))).toEqual({ item: undefined, count: before - 1 })
  } finally {
    withE2eDb((db) => db.prepare('DELETE FROM redeem_items WHERE id=?').run(itemId))
  }
})

test('user redemption history shows pending, failed, fulfilled, and unknown states safely', async ({ page }) => {
  await page.route('**/api/store', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        balance: 300,
        items: [],
        ledger: [],
        redemptions: [
          { id: 'pending', itemName: '排队中的兑换', cost: 10, status: 'pending', result: '', createdAt: 1 },
          { id: 'failed', itemName: '失败的兑换', cost: 20, status: 'failed', result: 'internal token=do-not-show', createdAt: 2 },
          { id: 'fulfilled', itemName: '已完成兑换', cost: 30, status: 'fulfilled', result: 'SAFE-CODE-123', createdAt: 3 },
          { id: 'unknown', itemName: '未知状态兑换', cost: 40, result: 'UNKNOWN-RESULT-HIDDEN', createdAt: 4 },
        ],
      }),
    })
  })

  await login(page)

  await expect(page.getByLabel('兑换状态：处理中')).toContainText('处理中')
  await expect(page.getByLabel('兑换状态：兑换失败')).toContainText('兑换失败')
  await expect(page.getByLabel('兑换状态：已完成')).toContainText('已完成')
  await expect(page.getByLabel('兑换状态：状态未知')).toContainText('状态未知')
  await expect(page.getByRole('button', { name: /SAFE-CODE-123/ })).toBeVisible()
  await expect(page.getByText('internal token=do-not-show')).toHaveCount(0)
  await expect(page.getByText('UNKNOWN-RESULT-HIDDEN')).toHaveCount(0)
})

test('admin health overview keeps liveness and readiness independent across refreshes', async ({ page }) => {
  let healthCalls = 0
  let readyCalls = 0
  await page.route('**/api/health', async (route) => {
    healthCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 800))
    if (healthCalls === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    } else {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'UNTRUSTED_INTERNAL_CODE',
          summary: '/srv/private/app.db token=health-secret host=internal-health.local',
        }),
      })
    }
  })
  await page.route('**/api/ready', async (route) => {
    readyCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 800))
    if (readyCalls === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'DATABASE_NOT_READY',
          summary: '/private/db.sqlite token=ready-secret',
          detail: 'Error stack at db.internal.local',
        }),
      })
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
  })

  await openAdmin(page)

  const live = page.getByTestId('liveness-status')
  const ready = page.getByTestId('readiness-status')
  await expect(live).toContainText('可用')
  await expect(ready).toContainText('不可用')
  await expect(ready).toContainText('数据库尚未就绪')
  for (const secret of ['/private/db.sqlite', 'ready-secret', 'db.internal.local']) {
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0)
  }

  const refresh = page.getByTestId('refresh-system-status')
  await refresh.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await expect(refresh).toBeDisabled()
  await expect(live).toContainText('检查中')
  await expect(ready).toContainText('检查中')
  await expect(live).toContainText('不可用')
  await expect(live).toContainText('进程状态检查不可用')
  await expect(ready).toContainText('可用')
  for (const secret of ['/srv/private/app.db', 'health-secret', 'internal-health.local']) {
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0)
  }
  expect(healthCalls).toBe(2)
  expect(readyCalls).toBe(2)
  await expect(page.getByText(/最近检查/)).toBeVisible()
})

test('real /api/ready fails closed for a broken schema and recovers without probe residue', async ({ request }) => {
  const healthy = await request.get('/api/ready')
  expect(healthy.status()).toBe(200)
  expect(await healthy.json()).toEqual({ ok: true })

  const brokenName = '__e2e_redeem_items_missing'
  withE2eDb((db) => {
    db.exec(`DROP TABLE IF EXISTS "${brokenName}"`)
    db.exec(`ALTER TABLE redeem_items RENAME TO "${brokenName}"`)
  })
  try {
    const broken = await request.get('/api/ready')
    expect(broken.status()).toBe(503)
    expect(await broken.json()).toEqual({
      ok: false,
      code: 'DATABASE_NOT_READY',
      summary: '数据库尚未就绪',
    })
  } finally {
    withE2eDb((db) => db.exec(`ALTER TABLE "${brokenName}" RENAME TO redeem_items`))
  }

  const recovered = await request.get('/api/ready')
  expect(recovered.status()).toBe(200)
  expect(await recovered.json()).toEqual({ ok: true })
  expect(withE2eDb((db) => db.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '__xjm_readiness_probe_%'",
  ).all())).toEqual([])
})

test('favicon endpoint returns a non-empty image response', async ({ request }) => {
  const response = await request.get('/favicon.ico')
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^image\//)
  expect((await response.body()).byteLength).toBeGreaterThan(32)
})

test('dashboard and admin load without blocking console or page errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  await login(page)
  await expect(page.getByRole('heading', { name: /贡献账号/ })).toBeVisible()
  await page.goto('/admin')
  await expect(page.getByTestId('liveness-status')).toContainText('可用')
  await expect(page.getByTestId('readiness-status')).toContainText('可用')

  expect(errors).toEqual([])
})
