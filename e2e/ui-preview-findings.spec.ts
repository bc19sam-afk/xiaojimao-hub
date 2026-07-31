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
  linuxdoId?: number
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
      args.linuxdoId ?? 1,
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

  await page.setViewportSize({ width: 320, height: 900 })
  const contributionsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/my-contributions')
  await login(page)
  const contributionsResponse = await contributionsResponsePromise
  expect(contributionsResponse.status()).toBe(200)
  const contributionsBody = await contributionsResponse.json() as {
    contributions?: Array<{ id?: unknown; accountId?: unknown }>
  }
  expect(contributionsBody.contributions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'e2e-long-dashboard', accountId: longAccount }),
  ]))
  await expect(page.getByText(longAccount, { exact: true })).toBeVisible()

  const providerSubtexts = [
    ['codex', 'ChatGPT', 'Plus / Pro / Team / K12'],
    ['claude', 'Claude', 'Claude 订阅'],
    ['grok', 'Grok', 'SuperGrok'],
  ] as const

  for (const width of [320, 375, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const layout = await page.evaluate(async (expectedProviders) => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      const documentElement = document.documentElement
      const providers = Array.from(document.querySelectorAll<HTMLElement>('[data-provider-option]')).map((option) => {
        const id = option.dataset.providerOption ?? ''
        const expected = expectedProviders.find(([expectedId]) => expectedId === id)
        const name = expected?.[1] ?? ''
        const subtext = expected?.[2] ?? ''
        const optionRect = option.getBoundingClientRect()
        const mainTextNode = Array.from(option.querySelectorAll<HTMLElement>('*')).find(
          (node) => node.textContent?.trim() === name,
        )
        const subtextNode = Array.from(option.querySelectorAll<HTMLElement>('*')).find(
          (node) => node.textContent?.trim() === subtext,
        )
        const measureEffectivePath = (node: HTMLElement | undefined) => {
          if (!node) return null
          const path: Array<{
            tag: string
            display: string
            visibility: string
            opacity: number
            rectCount: number
            width: number
            height: number
          }> = []
          let current: HTMLElement | null = node
          while (current) {
            const style = getComputedStyle(current)
            const rect = current.getBoundingClientRect()
            path.push({
              tag: current.tagName,
              display: style.display,
              visibility: style.visibility,
              opacity: Number(style.opacity),
              rectCount: current.getClientRects().length,
              width: rect.width,
              height: rect.height,
            })
            if (current === option) break
            current = current.parentElement
          }
          return {
            reachesOption: current === option,
            cumulativeOpacity: path.reduce((opacity, entry) => opacity * entry.opacity, 1),
            path,
          }
        }
        const measureText = (node: HTMLElement | undefined) => {
          if (!node) return null
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            text: node.textContent?.trim() ?? '',
            display: style.display,
            visibility: style.visibility,
            opacity: Number(style.opacity),
            rectCount: node.getClientRects().length,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            effectivePath: measureEffectivePath(node),
          }
        }
        return {
          id,
          text: option.textContent ?? '',
          ariaLabel: option.getAttribute('aria-label') ?? '',
          bounds: {
            left: optionRect.left,
            right: optionRect.right,
            top: optionRect.top,
            bottom: optionRect.bottom,
            width: optionRect.width,
            height: optionRect.height,
          },
          effectivePath: measureEffectivePath(option),
          mainText: measureText(mainTextNode),
          subtext: measureText(subtextNode),
        }
      })
      const scroller = document.querySelector('table')?.parentElement
      const scrollerRect = scroller?.getBoundingClientRect()
      return {
        pageWidth: documentElement.clientWidth,
        pageHeight: documentElement.clientHeight,
        scrollWidth: documentElement.scrollWidth,
        providers,
        scroller: scroller && scrollerRect
          ? {
              left: scrollerRect.left,
              right: scrollerRect.right,
              clientWidth: scroller.clientWidth,
              scrollWidth: scroller.scrollWidth,
            }
          : null,
      }
    }, providerSubtexts)

    expect(layout.scrollWidth, `${width}px 页面不应横向溢出`).toBeLessThanOrEqual(layout.pageWidth + 1)
    expect(layout.providers).toHaveLength(3)
    for (const [id, name, subtext] of providerSubtexts) {
      const option = layout.providers.find((provider) => provider.id === id)
      expect(option?.text).toContain(name)
      expect(option?.ariaLabel).toContain(name)
      expect(option?.ariaLabel).toContain(subtext)
      expect(option?.bounds).not.toBeNull()
      expect(option?.bounds?.width).toBeGreaterThan(0)
      expect(option?.bounds?.height).toBeGreaterThan(0)
      expect(option?.bounds?.left).toBeGreaterThanOrEqual(0)
      expect(option?.bounds?.right).toBeLessThanOrEqual(layout.pageWidth + 1)
      expect(option?.bounds?.top).toBeGreaterThanOrEqual(0)
      expect(option?.bounds?.bottom).toBeLessThanOrEqual(layout.pageHeight + 1)
      if (!option?.effectivePath) throw new Error(`${width}px ${id} provider 可见性路径缺失`)
      expect(option.effectivePath.reachesOption).toBe(true)
      expect(option.effectivePath.cumulativeOpacity).toBeGreaterThan(0)
      for (const ancestor of option.effectivePath.path) {
        expect(ancestor.display).not.toBe('none')
        expect(['hidden', 'collapse']).not.toContain(ancestor.visibility)
        expect(ancestor.opacity).toBeGreaterThan(0)
        expect(ancestor.rectCount).toBeGreaterThan(0)
        expect(ancestor.width).toBeGreaterThan(0)
        expect(ancestor.height).toBeGreaterThan(0)
      }
      for (const [label, expectedText, textLayout] of [
        ['主文案', name, option?.mainText],
        ['副文案', subtext, option?.subtext],
      ] as const) {
        if (!option?.bounds || !textLayout) throw new Error(`${width}px ${id} ${label}缺失`)
        expect(textLayout.text).toBe(expectedText)
        expect(textLayout.display).not.toBe('none')
        expect(['hidden', 'collapse']).not.toContain(textLayout.visibility)
        expect(textLayout.opacity).toBeGreaterThan(0)
        expect(textLayout.rectCount).toBeGreaterThan(0)
        expect(textLayout.width).toBeGreaterThan(0)
        expect(textLayout.height).toBeGreaterThan(0)
        expect(textLayout.left).toBeGreaterThanOrEqual(option.bounds.left - 1)
        expect(textLayout.right).toBeLessThanOrEqual(option.bounds.right + 1)
        expect(textLayout.top).toBeGreaterThanOrEqual(option.bounds.top - 1)
        expect(textLayout.bottom).toBeLessThanOrEqual(option.bounds.bottom + 1)
        expect(textLayout.left).toBeGreaterThanOrEqual(0)
        expect(textLayout.right).toBeLessThanOrEqual(layout.pageWidth + 1)
        expect(textLayout.top).toBeGreaterThanOrEqual(0)
        expect(textLayout.bottom).toBeLessThanOrEqual(layout.pageHeight + 1)
        expect(textLayout.scrollWidth).toBeLessThanOrEqual(textLayout.clientWidth + 1)
        if (!textLayout.effectivePath) throw new Error(`${width}px ${id} ${label}祖先可见性路径缺失`)
        expect(textLayout.effectivePath.reachesOption).toBe(true)
        expect(textLayout.effectivePath.cumulativeOpacity).toBeGreaterThan(0)
        for (const ancestor of textLayout.effectivePath.path) {
          expect(ancestor.display).not.toBe('none')
          expect(['hidden', 'collapse']).not.toContain(ancestor.visibility)
          expect(ancestor.opacity).toBeGreaterThan(0)
          expect(ancestor.rectCount).toBeGreaterThan(0)
          expect(ancestor.width).toBeGreaterThan(0)
          expect(ancestor.height).toBeGreaterThan(0)
        }
      }
    }
    expect(layout.scroller).not.toBeNull()
    expect(layout.scroller?.left).toBeGreaterThanOrEqual(0)
    expect(layout.scroller?.right).toBeLessThanOrEqual(layout.pageWidth + 1)
    if (width === 320) expect(layout.scroller?.scrollWidth).toBeGreaterThan(layout.scroller?.clientWidth ?? 0)
  }

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
      const layout = await result.evaluate(async (node) => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
        const rect = node.getBoundingClientRect()
        return {
          pageWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          result: {
            left: rect.left,
            right: rect.right,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
          },
        }
      })
      expect(layout.scrollWidth, `${width}px 长 CDK 页面不应横向溢出`).toBeLessThanOrEqual(layout.pageWidth + 1)
      expect(layout.result.left).toBeGreaterThanOrEqual(0)
      expect(layout.result.right).toBeLessThanOrEqual(layout.pageWidth + 1)
      expect(layout.result.scrollWidth).toBeLessThanOrEqual(layout.result.clientWidth + 1)
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
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const suffix = Date.now()
  const startupBrokenAudit = `__e2e_startup_audit_log_${suffix}`
  withE2eDb((db) => db.exec(`ALTER TABLE audit_log RENAME TO "${startupBrokenAudit}"`))
  try {
    const health = await page.request.get('/api/health')
    expect(health.status()).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    const ready = await page.request.get('/api/ready')
    expect(ready.status()).toBe(503)
    expect(await ready.json()).toEqual({
      ok: false,
      code: 'DATABASE_NOT_READY',
      summary: '数据库尚未就绪',
    })

    await openAdmin(page)
    await expect(page.getByRole('heading', { name: '管理后台', level: 1 })).toBeVisible()
    await expect(page.getByTestId('readiness-status')).toContainText('不可用')
    await expect(page.getByTestId('audit-load-error')).toHaveText('审计记录暂时无法加载，请重试')
    const auditResponse = await page.request.get('/api/admin/audit?limit=50')
    expect(auditResponse.status()).toBe(500)
    expect(auditResponse.headers()['content-type']).toContain('application/json')
    expect(await auditResponse.json()).toEqual({
      ok: false,
      code: 'AUDIT_LOAD_FAILED',
      error: '审计记录暂时无法加载，请重试',
    })
    expect(pageErrors).toEqual([])
  } finally {
    withE2eDb((db) => db.exec(`ALTER TABLE "${startupBrokenAudit}" RENAME TO audit_log`))
  }
  await page.getByTestId('refresh-audit').click()
  await expect(page.getByTestId('audit-load-error')).toHaveCount(0)
  await page.getByTestId('refresh-system-status').click()
  await expect(page.getByTestId('readiness-status')).toContainText('可用')
  expect(pageErrors).toEqual([])

  const invalidUpdateSnapshot = withE2eDb((db) => ({
    items: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items').get() as { n: number }).n,
    audits: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n,
  }))
  const invalidUpdatePayload = {
    name: `E2E invalid update ${suffix}`,
    description: 'must never become a create',
    cost: 9,
    kind: 'timed_quota',
    enabled: true,
    sort: 0,
    fulfillment: 'placeholder',
    perUserLimit: 0,
  }
  for (const id of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await page.request.put('/api/admin/redeem-items', {
      data: { ...invalidUpdatePayload, id },
    })
    expect(response.status()).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'REDEEM_ITEM_INVALID_ID',
      error: '商品 ID 无效',
    })
  }
  const malformedIdResponse = await page.request.put('/api/admin/redeem-items', {
    headers: { 'Content-Type': 'application/json' },
    data: `{"id":NaN,"name":"${invalidUpdatePayload.name}","description":"","cost":9,"kind":"timed_quota","enabled":true,"sort":0}`,
  })
  expect(malformedIdResponse.status()).toBe(400)
  expect(await malformedIdResponse.json()).toEqual({
    ok: false,
    code: 'REDEEM_ITEM_INVALID',
    error: '商品信息不完整',
  })
  const missingUpdate = await page.request.put('/api/admin/redeem-items', {
    data: { ...invalidUpdatePayload, id: Number.MAX_SAFE_INTEGER },
  })
  expect(missingUpdate.status()).toBe(404)
  expect(await missingUpdate.json()).toEqual({
    ok: false,
    code: 'REDEEM_ITEM_NOT_FOUND',
    error: '兑换项不存在或已被删除',
  })
  expect(withE2eDb((db) => ({
    items: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items').get() as { n: number }).n,
    audits: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n,
    accidentalCreates: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE name=?').get(
      invalidUpdatePayload.name,
    ) as { n: number }).n,
  }))).toEqual({ ...invalidUpdateSnapshot, accidentalCreates: 0 })

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

  // 商品保存也必须把旧值读取、upsert、audit、overview/列表读回放在同一事务。
  const saveSnapshot = withE2eDb((db) => {
    const item = db.prepare(
      `SELECT id, name, description, cost, kind, enabled, sort, config, fulfillment,
              per_user_limit AS perUserLimit
       FROM redeem_items WHERE enabled=1 ORDER BY id LIMIT 1`,
    ).get() as {
      id: number
      name: string
      description: string
      cost: number
      kind: string
      enabled: number
      sort: number
      config: string
      fulfillment: string
      perUserLimit: number
    }
    return {
      item,
      enabledCount: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1').get() as { n: number }).n,
      totalCount: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items').get() as { n: number }).n,
      auditCount: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n,
      sequence: (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='redeem_items'").get() as { seq: number }).seq,
    }
  })
  const failedCreateName = `E2E atomic create ${suffix}`
  const failedCreateKey = `e2e-atomic-create-${crypto.randomUUID()}`
  const brokenSaveAudit = `__e2e_save_audit_log_${suffix}`
  let updateResponseStatus = 0
  let updateResponseType = ''
  let updateResponseText = ''
  let createResponseStatus = 0
  let createResponseType = ''
  let createResponseText = ''
  let failedSaveState: ReturnType<typeof withE2eDb<{
    item: typeof saveSnapshot.item | undefined
    created: { id: number } | undefined
    enabledCount: number
    totalCount: number
    auditCount: number
    intentCount: number
    sequence: number
  }>>
  withE2eDb((db) => db.exec(`ALTER TABLE audit_log RENAME TO "${brokenSaveAudit}"`))
  try {
    const updateResponse = await page.request.put('/api/admin/redeem-items', {
      data: { ...saveSnapshot.item, name: `${saveSnapshot.item.name} changed`, enabled: false },
    })
    updateResponseStatus = updateResponse.status()
    updateResponseType = updateResponse.headers()['content-type'] ?? ''
    updateResponseText = await updateResponse.text()

    const createResponse = await page.request.put('/api/admin/redeem-items', {
      headers: { 'Idempotency-Key': failedCreateKey },
      data: {
        name: failedCreateName,
        description: 'must roll back with audit failure',
        cost: 7,
        kind: 'timed_quota',
        enabled: false,
        sort: 999,
      },
    })
    createResponseStatus = createResponse.status()
    createResponseType = createResponse.headers()['content-type'] ?? ''
    createResponseText = await createResponse.text()

    failedSaveState = withE2eDb((db) => ({
      item: db.prepare(
        `SELECT id, name, description, cost, kind, enabled, sort, config, fulfillment,
                per_user_limit AS perUserLimit FROM redeem_items WHERE id=?`,
      ).get(saveSnapshot.item.id) as typeof saveSnapshot.item | undefined,
      created: db.prepare('SELECT id FROM redeem_items WHERE name=?').get(failedCreateName) as { id: number } | undefined,
      enabledCount: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1').get() as { n: number }).n,
      totalCount: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items').get() as { n: number }).n,
      auditCount: (db.prepare(`SELECT COUNT(*) AS n FROM "${brokenSaveAudit}"`).get() as { n: number }).n,
      intentCount: (db.prepare(
        'SELECT COUNT(*) AS n FROM redeem_item_create_requests WHERE request_key=?',
      ).get(failedCreateKey) as { n: number }).n,
      sequence: (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='redeem_items'").get() as { seq: number }).seq,
    }))
  } finally {
    withE2eDb((db) => {
      db.exec(`ALTER TABLE "${brokenSaveAudit}" RENAME TO audit_log`)
      db.prepare(
        `UPDATE redeem_items SET name=?, description=?, cost=?, kind=?, enabled=?, sort=?, config=?,
           fulfillment=?, per_user_limit=? WHERE id=?`,
      ).run(
        saveSnapshot.item.name,
        saveSnapshot.item.description,
        saveSnapshot.item.cost,
        saveSnapshot.item.kind,
        saveSnapshot.item.enabled,
        saveSnapshot.item.sort,
        saveSnapshot.item.config,
        saveSnapshot.item.fulfillment,
        saveSnapshot.item.perUserLimit,
        saveSnapshot.item.id,
      )
      db.prepare('DELETE FROM redeem_items WHERE name=?').run(failedCreateName)
      db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='redeem_items'").run(saveSnapshot.sequence)
    })
  }
  const saveFailureBody = {
    ok: false,
    code: 'REDEEM_ITEM_SAVE_FAILED',
    error: '保存兑换项失败，请重试',
  }
  expect(updateResponseStatus).toBe(500)
  expect(updateResponseType).toContain('application/json')
  expect(JSON.parse(updateResponseText)).toEqual(saveFailureBody)
  expect(createResponseStatus).toBe(500)
  expect(createResponseType).toContain('application/json')
  expect(JSON.parse(createResponseText)).toEqual(saveFailureBody)
  expect(failedSaveState!).toEqual({
    item: saveSnapshot.item,
    created: undefined,
    enabledCount: saveSnapshot.enabledCount,
    totalCount: saveSnapshot.totalCount,
    auditCount: saveSnapshot.auditCount,
    intentCount: 0,
    sequence: saveSnapshot.sequence,
  })
})

test('successful delete, retry, and terminate use exact targets, persist audit state, and restore stable focus', async ({ page }) => {
  await openAdmin(page)

  const itemName = `E2E focus item ${Date.now()}`
  const created = await page.evaluate(async (name) => {
    const response = await fetch('/api/admin/redeem-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-focus-create-${crypto.randomUUID()}` },
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
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const item = withE2eDb((db) => db.prepare(
    'SELECT id, name FROM redeem_items WHERE enabled=1 ORDER BY id LIMIT 1',
  ).get() as { id: number; name: string })
  const before = withE2eDb((db) => (db.prepare(
    'SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1',
  ).get() as { n: number }).n)
  const overviewValue = page.getByText('已启用商品', { exact: true }).locator('..').locator('dd')
  const row = page.locator(`input[value="${item.name}"]`).locator('..')
  const validResponse = withE2eDb((db) => ({
    ok: true,
    redeemItems: db.prepare(
      `SELECT id, name, description, cost, kind, enabled, sort, config, fulfillment,
              per_user_limit AS perUserLimit FROM redeem_items ORDER BY sort, cost`,
    ).all(),
    overview: {
      pooledAccounts: (db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE verify_status='pooled'").get() as { n: number }).n,
      needsReview: (db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE verify_status='needs_review'").get() as { n: number }).n,
      pendingRedemptions: (db.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE status='pending'").get() as { n: number }).n,
      enabledRedeemItems: before,
    },
  }))
  let malformedBody: unknown = null
  let saveMode: 'malformed' | 'non-json' | 'network' | 'intent-failure' | 'lost-create' | 'success' = 'malformed'
  let saveRequests = 0
  let lostCreateName = ''
  let lostCreateOriginBody: Record<string, unknown> | null = null
  let releaseLostCreate!: () => void
  let lostCreateGate = Promise.resolve()
  const createIntentKeys: string[] = []
  await page.route('**/api/admin/redeem-items', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback()
      return
    }
    saveRequests += 1
    const requestBody = route.request().postDataJSON() as { id?: unknown; name?: unknown }
    if (!Object.prototype.hasOwnProperty.call(requestBody, 'id')) {
      createIntentKeys.push(route.request().headers()['idempotency-key'] ?? '')
    }
    if (saveMode === 'malformed') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(malformedBody) })
      return
    }
    if (saveMode === 'non-json') {
      await route.fulfill({ status: 500, contentType: 'text/plain', body: 'internal path token stack' })
      return
    }
    if (saveMode === 'network') {
      await route.abort('failed')
      return
    }
    if (saveMode === 'intent-failure') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, code: 'REDEEM_ITEM_SAVE_FAILED', error: 'internal' }),
      })
      return
    }
    if (saveMode === 'lost-create' && requestBody.name === lostCreateName) {
      await lostCreateGate
      const origin = await route.fetch()
      lostCreateOriginBody = await origin.json() as Record<string, unknown>
      await route.abort('failed')
      return
    }
    await route.fallback()
  })

  try {
    await expect(overviewValue).toHaveText(String(before))
    await row.locator('input[type="checkbox"]').uncheck()

    const firstValidItem = validResponse.redeemItems[0] as Record<string, unknown>
    const malformedCases = [
      { ...validResponse, redeemItems: [null] },
      { ...validResponse, redeemItems: [{ ...firstValidItem, config: undefined }] },
      { ...validResponse, redeemItems: [{ ...firstValidItem, enabled: '1' }] },
      { ...validResponse, redeemItems: [{ ...firstValidItem, cost: -1 }] },
      { ...validResponse, redeemItems: [{ ...firstValidItem, id: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...validResponse, redeemItems: [firstValidItem, null] },
      { ...validResponse, overview: { ...validResponse.overview, enabledRedeemItems: -1 } },
    ]
    for (const body of malformedCases) {
      malformedBody = body
      const expectedRequests = saveRequests + 1
      await row.getByRole('button', { name: '保存' }).click()
      await expect.poll(() => saveRequests).toBe(expectedRequests)
      const itemError = page.getByTestId('redeem-item-error')
      await expect(itemError).toHaveRole('alert')
      await expect(itemError).toHaveText('保存兑换项失败，请重试')
      await expect(itemError).toHaveClass(/text-rose-/)
      await expect(overviewValue).toHaveText(String(before))
      expect(withE2eDb((db) => (db.prepare(
        'SELECT enabled FROM redeem_items WHERE id=?',
      ).get(item.id) as { enabled: number }).enabled)).toBe(1)
    }

    saveMode = 'non-json'
    let expectedRequests = saveRequests + 1
    await row.getByRole('button', { name: '保存' }).click()
    await expect.poll(() => saveRequests).toBe(expectedRequests)
    await expect(page.getByTestId('redeem-item-error')).toHaveText('保存兑换项失败，请重试')
    await expect(overviewValue).toHaveText(String(before))
    expect(withE2eDb((db) => (db.prepare('SELECT enabled FROM redeem_items WHERE id=?').get(item.id) as { enabled: number }).enabled)).toBe(1)

    saveMode = 'network'
    expectedRequests = saveRequests + 1
    await row.getByRole('button', { name: '保存' }).click()
    await expect.poll(() => saveRequests).toBe(expectedRequests)
    await expect(page.getByTestId('redeem-item-error')).toHaveText('保存兑换项失败，请重试')
    await expect(overviewValue).toHaveText(String(before))
    expect(pageErrors).toEqual([])

    saveMode = 'success'
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/admin/redeem-items'))
    await row.getByRole('button', { name: '保存' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    const responseBody = await response.json()
    expect(responseBody.ok).toBe(true)
    expect(responseBody.overview.enabledRedeemItems).toBe(before - 1)
    expect(responseBody.redeemItems.find((entry: { id: number }) => entry.id === item.id)?.enabled).toBe(0)

    await expect(overviewValue).toHaveText(String(before - 1))
    const persisted = withE2eDb((db) => ({
      enabled: (db.prepare('SELECT enabled FROM redeem_items WHERE id=?').get(item.id) as { enabled: number }).enabled,
      count: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE enabled=1').get() as { n: number }).n,
      audit: db.prepare(
        "SELECT action, target, new_value AS newValue FROM audit_log WHERE action='redeem_item.upsert' AND target LIKE ? ORDER BY id DESC LIMIT 1",
      ).get(`item#${item.id}%`) as { action: string; target: string; newValue: string },
    }))
    expect(persisted.enabled).toBe(0)
    expect(persisted.count).toBe(before - 1)
    expect(persisted.audit.action).toBe('redeem_item.upsert')
    expect(persisted.audit.target).toContain(`item#${item.id}`)
    expect(JSON.parse(persisted.audit.newValue).enabled).toBe(0)
    expect(pageErrors).toEqual([])

    // Create intent: duplicate clicks while pending send once; if the origin commits but the
    // response is lost, retry must reuse the same persistent idempotency key and item/audit.
    lostCreateName = `E2E idempotent create ${Date.now()}`
    lostCreateGate = new Promise<void>((resolve) => { releaseLostCreate = resolve })
    saveMode = 'lost-create'
    const newRow = page.getByTestId('redeem-item-new-row')
    await newRow.getByPlaceholder('名称').fill(lostCreateName)
    await newRow.getByRole('spinbutton').first().fill('13')
    const createButton = newRow.getByTestId('redeem-item-save')
    const createRequestsBefore = saveRequests
    await createButton.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect(createButton).toBeDisabled()
    await expect.poll(() => saveRequests).toBe(createRequestsBefore + 1)
    releaseLostCreate()
    await expect(page.getByTestId('redeem-item-error')).toHaveText('保存兑换项失败，请重试')
    const lostIntentKey = createIntentKeys.at(-1) ?? ''
    const afterLostResponse = withE2eDb((db) => ({
      items: db.prepare('SELECT id FROM redeem_items WHERE name=?').all(lostCreateName) as Array<{ id: number }>,
      audits: (db.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action='redeem_item.upsert' AND new_value LIKE ?",
      ).get(`%${lostCreateName}%`) as { n: number }).n,
      intents: (db.prepare(
        'SELECT COUNT(*) AS n FROM redeem_item_create_requests WHERE request_key=?',
      ).get(lostIntentKey) as { n: number }).n,
    }))
    expect(afterLostResponse.items).toHaveLength(1)
    expect(afterLostResponse.audits).toBe(1)
    expect(afterLostResponse.intents).toBe(1)

    saveMode = 'success'
    const retryResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/admin/redeem-items'))
    await createButton.click()
    const retryResponse = await retryResponsePromise
    expect(retryResponse.status()).toBe(200)
    const retryBody = await retryResponse.json() as {
      ok: boolean
      redeemItems: Array<{ id: number; name: string }>
    }
    expect(retryBody.ok).toBe(true)
    const firstBodyItems = (
      (lostCreateOriginBody as Record<string, unknown> | null)?.redeemItems ?? []
    ) as Array<{ id: number; name: string }>
    const firstItemId = firstBodyItems.find((entry) => entry.name === lostCreateName)?.id
    const retriedItemId = retryBody.redeemItems.find((entry) => entry.name === lostCreateName)?.id
    expect(firstItemId).toBeGreaterThan(0)
    expect(retriedItemId).toBe(firstItemId)
    expect(createIntentKeys.slice(-2)[0]).toBeTruthy()
    expect(createIntentKeys.slice(-2)[1]).toBe(createIntentKeys.slice(-2)[0])
    expect(withE2eDb((db) => ({
      items: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE name=?').get(lostCreateName) as { n: number }).n,
      audits: (db.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action='redeem_item.upsert' AND new_value LIKE ?",
      ).get(`%${lostCreateName}%`) as { n: number }).n,
    }))).toEqual({ items: 1, audits: 1 })

    saveMode = 'intent-failure'
    const intentStart = createIntentKeys.length
    await newRow.getByPlaceholder('名称').fill(`E2E edited intent ${Date.now()}`)
    await createButton.click()
    await expect.poll(() => createIntentKeys.length).toBe(intentStart + 1)
    await expect(page.getByTestId('redeem-item-error')).toHaveText('保存兑换项失败，请重试')
    const originalIntentKey = createIntentKeys.at(-1)
    await newRow.getByPlaceholder('说明').fill('edited after a retryable failure')
    await createButton.click()
    await expect.poll(() => createIntentKeys.length).toBe(intentStart + 2)
    const editedIntentKey = createIntentKeys.at(-1)
    expect(originalIntentKey).toBeTruthy()
    expect(editedIntentKey).toBeTruthy()
    expect(editedIntentKey).not.toBe(originalIntentKey)

    saveMode = 'success'
    const concurrentName = `E2E concurrent idempotent create ${Date.now()}`
    const concurrentKey = `e2e-concurrent-${crypto.randomUUID()}`
    const concurrentPayload = {
      name: concurrentName,
      description: 'concurrent create',
      cost: 17,
      kind: 'timed_quota',
      enabled: true,
      sort: 998,
      fulfillment: 'placeholder',
      perUserLimit: 0,
    }
    const [concurrentA, concurrentB] = await Promise.all([
      page.request.put('/api/admin/redeem-items', {
        headers: { 'Idempotency-Key': concurrentKey },
        data: concurrentPayload,
      }),
      page.request.put('/api/admin/redeem-items', {
        headers: { 'Idempotency-Key': concurrentKey },
        data: concurrentPayload,
      }),
    ])
    expect(concurrentA.status()).toBe(200)
    expect(concurrentB.status()).toBe(200)
    const concurrentBodyA = await concurrentA.json()
    const concurrentBodyB = await concurrentB.json()
    const concurrentIdA = concurrentBodyA.redeemItems.find((entry: { name: string }) => entry.name === concurrentName)?.id
    const concurrentIdB = concurrentBodyB.redeemItems.find((entry: { name: string }) => entry.name === concurrentName)?.id
    expect(concurrentIdA).toBeGreaterThan(0)
    expect(concurrentIdB).toBe(concurrentIdA)
    expect(withE2eDb((db) => ({
      items: (db.prepare('SELECT COUNT(*) AS n FROM redeem_items WHERE name=?').get(concurrentName) as { n: number }).n,
      audits: (db.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action='redeem_item.upsert' AND new_value LIKE ?",
      ).get(`%${concurrentName}%`) as { n: number }).n,
      intents: (db.prepare(
        'SELECT COUNT(*) AS n FROM redeem_item_create_requests WHERE request_key=?',
      ).get(concurrentKey) as { n: number }).n,
    }))).toEqual({ items: 1, audits: 1, intents: 1 })

    const conflict = await page.request.put('/api/admin/redeem-items', {
      headers: { 'Idempotency-Key': concurrentKey },
      data: { ...concurrentPayload, name: `${concurrentName} changed` },
    })
    expect(conflict.status()).toBe(409)
    expect(await conflict.json()).toEqual({
      ok: false,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      error: '该新增请求与已提交内容不一致，请重新编辑后再试',
    })
  } finally {
    releaseLostCreate?.()
    withE2eDb((db) => {
      db.prepare('UPDATE redeem_items SET enabled=1 WHERE id=?').run(item.id)
      if (lostCreateName) db.prepare('DELETE FROM redeem_items WHERE name=?').run(lostCreateName)
      db.prepare("DELETE FROM redeem_items WHERE name LIKE 'E2E concurrent idempotent create %'").run()
      const hasIntentTable = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='redeem_item_create_requests'",
      ).get()
      if (hasIntentTable) {
        db.prepare("DELETE FROM redeem_item_create_requests WHERE request_key LIKE 'e2e-concurrent-%'").run()
        for (const key of createIntentKeys.filter(Boolean)) {
          db.prepare('DELETE FROM redeem_item_create_requests WHERE request_key=?').run(key)
        }
      }
    })
  }
})

test('deleting an item applies the DELETE overview and ignores a stale config refresh', async ({ page }) => {
  await openAdmin(page)
  const itemName = `E2E DELETE overview ${Date.now()}`
  const created = await page.evaluate(async (name) => {
    const response = await fetch('/api/admin/redeem-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-delete-overview-${crypto.randomUUID()}` },
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

test('admin DELETE routes reject invalid or missing IDs without changing rows or audit history', async ({ page }) => {
  await openAdmin(page)
  const invalidIds = ['-1', '0', '1.5', 'NaN', 'not-a-number', '1e3', String(Number.MAX_SAFE_INTEGER + 1)]
  const missingId = String(Number.MAX_SAFE_INTEGER)
  const routes = [
    {
      endpoint: 'point-rules',
      table: 'point_rules',
      auditAction: 'point_rule.delete',
      invalid: { ok: false, code: 'POINT_RULE_INVALID_ID', error: '发分规则 ID 无效' },
      missing: { ok: false, code: 'POINT_RULE_NOT_FOUND', error: '发分规则不存在或已被删除' },
    },
    {
      endpoint: 'usage-rates',
      table: 'usage_rates',
      auditAction: 'usage_rate.delete',
      invalid: { ok: false, code: 'USAGE_RATE_INVALID_ID', error: '折算规则 ID 无效' },
      missing: { ok: false, code: 'USAGE_RATE_NOT_FOUND', error: '折算规则不存在或已被删除' },
    },
    {
      endpoint: 'redeem-items',
      table: 'redeem_items',
      auditAction: 'redeem_item.delete',
      invalid: { ok: false, code: 'REDEEM_ITEM_INVALID_ID', error: '商品 ID 无效' },
      missing: { ok: false, code: 'REDEEM_ITEM_NOT_FOUND', error: '兑换项不存在或已被删除' },
    },
  ] as const

  for (const route of routes) {
    const before = withE2eDb((db) => ({
      rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${route.table}`).get() as { n: number }).n,
      audits: (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action=?').get(route.auditAction) as { n: number }).n,
    }))

    for (const id of invalidIds) {
      const response = await page.request.delete(`/api/admin/${route.endpoint}?id=${encodeURIComponent(id)}`)
      expect(response.status(), `${route.endpoint} id=${id}`).toBe(400)
      expect(await response.json()).toEqual(route.invalid)
    }

    const missing = await page.request.delete(`/api/admin/${route.endpoint}?id=${missingId}`)
    expect(missing.status()).toBe(404)
    expect(await missing.json()).toEqual(route.missing)

    expect(withE2eDb((db) => ({
      rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${route.table}`).get() as { n: number }).n,
      audits: (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action=?').get(route.auditAction) as { n: number }).n,
    }))).toEqual(before)
  }
})

test('admin keeps page width bounded and primary controls visible at mobile and desktop widths', async ({ page }) => {
  const suffix = Date.now()
  const contributionId = `admin-layout-${suffix}`
  const redemptionId = `admin-layout-redemption-${suffix}`
  const layoutLinuxdoId = 8_000_000 + (suffix % 1_000_000)
  const longAccount = `admin-${'long-account-segment-'.repeat(18)}tail`
  const longUsername = `admin_${'long_username_'.repeat(36)}tail`
  seedContribution({
    id: contributionId,
    accountId: longAccount,
    username: longUsername,
    linuxdoId: layoutLinuxdoId,
    verifyStatus: 'needs_review',
  })
  withE2eDb((db) => {
    db.prepare(
      `INSERT INTO daily_settlements
       (contribution_id, date, provider, account_id, call_count, points, settled_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(contributionId, '2026-07-31', 'grok', longAccount, 987_654_321, 123_456_789, Date.now())
    db.prepare(
      `INSERT INTO audit_log
       (actor_type, actor_id, actor_label, action, target, old_value, new_value, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('password', null, '管理员', 'layout.probe', longAccount, JSON.stringify({ value: longAccount }), null, Date.now())
    db.prepare('DELETE FROM redemptions WHERE id=?').run(redemptionId)
    db.prepare(
      `INSERT INTO redemptions
       (id, linuxdo_id, item_id, item_name, cost, status, result, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(redemptionId, layoutLinuxdoId, 1, '移动端长用户名布局验证', 987_654_321, 'fulfilled', '', Date.now())
  })

  try {
    await page.setViewportSize({ width: 390, height: 900 })
    await openAdmin(page)
    await expect(page.getByTestId('review-table-scroll').getByText(longUsername, { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('contributions-table-scroll').getByText(longAccount, { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('settlements-table-scroll').getByText(longAccount, { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('audit-table-scroll').getByText(longAccount, { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('contributions-table-scroll').getByText(longUsername, { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('settlements-table-scroll').getByText(longUsername, { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('redemptions-table-scroll').getByText(longUsername, { exact: true })).toHaveCount(1)
    const longCdk = `CDK-${'X'.repeat(500)}`
    await page.getByPlaceholder('一行一码，或用逗号 / 空格分隔').fill(longCdk)

    const retryButton = page.getByRole('button', { name: `重试人工复核 grok ${longAccount}` })
    const terminateButton = page.getByRole('button', { name: `终止人工复核 grok ${longAccount}` })

    for (const width of [320, 375, 390, 430, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await retryButton.scrollIntoViewIfNeeded()
      const layout = await page.evaluate(async ({ expectedLongAccount, expectedLongUsername }) => {
        const reviewScroll = document.querySelector<HTMLElement>('[data-testid="review-table-scroll"]')
        if (reviewScroll) reviewScroll.scrollLeft = reviewScroll.scrollWidth
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const root = document.documentElement
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="一行一码，或用逗号 / 空格分隔"]')
        const keyElements = [
          document.querySelector<HTMLElement>('[data-testid="refresh-system-status"]'),
          document.querySelector<HTMLElement>('[data-testid="refresh-audit"]'),
          document.querySelector<HTMLElement>('[data-testid="redeem-item-save"]'),
          textarea,
          buttons.find((button) => button.textContent?.trim() === '导入') ?? null,
        ]
        const scrollAreas = [
          'audit-table-scroll',
          'review-table-scroll',
          'contributions-table-scroll',
          'settlements-table-scroll',
          'redemptions-table-scroll',
        ].map((testId) => {
          const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
          if (!element) return null
          const rect = element.getBoundingClientRect()
          return {
            testId,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflowX: getComputedStyle(element).overflowX,
            containsLongAccount: element.textContent?.includes(expectedLongAccount) ?? false,
          }
        })
        const userCells = [
          'review-table-scroll',
          'contributions-table-scroll',
          'settlements-table-scroll',
          'redemptions-table-scroll',
        ].map((testId) => {
          const table = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
          const cell = table
            ? Array.from(table.querySelectorAll<HTMLElement>('span')).find(
                (candidate) => candidate.childElementCount === 0 && candidate.textContent === expectedLongUsername,
              )
            : undefined
          if (!cell) return null
          const cellRect = cell.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(cell)
          const fragments = Array.from(range.getClientRects()).map((rect) => ({
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          }))
          const style = getComputedStyle(cell)
          return {
            testId,
            left: cellRect.left,
            right: cellRect.right,
            width: cellRect.width,
            height: cellRect.height,
            clientWidth: cell.clientWidth,
            scrollWidth: cell.scrollWidth,
            overflowX: style.overflowX,
            wordBreak: style.wordBreak,
            overflowWrap: style.overflowWrap,
            fragments,
          }
        })
        const actionButtons = [
          `重试人工复核 grok ${expectedLongAccount}`,
          `终止人工复核 grok ${expectedLongAccount}`,
        ].map((label) => {
          const button = buttons.find((candidate) => candidate.getAttribute('aria-label') === label)
          if (!button || !reviewScroll) return null
          const buttonRect = button.getBoundingClientRect()
          const scrollRect = reviewScroll.getBoundingClientRect()
          const hit = document.elementFromPoint(
            buttonRect.left + buttonRect.width / 2,
            buttonRect.top + buttonRect.height / 2,
          )
          const textRange = document.createRange()
          textRange.selectNodeContents(button)
          const textRect = textRange.getBoundingClientRect()
          return {
            label,
            left: buttonRect.left,
            right: buttonRect.right,
            width: buttonRect.width,
            height: buttonRect.height,
            scrollLeft: scrollRect.left,
            scrollRight: scrollRect.right,
            textLeft: textRect.left,
            textRight: textRect.right,
            hit: hit === button || button.contains(hit),
            visible: getComputedStyle(button).visibility === 'visible' && Number(getComputedStyle(button).opacity) > 0,
          }
        })
        return {
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          textareaLength: textarea?.value.length ?? -1,
          controls: keyElements.map((element) => {
            if (!element) return null
            const rect = element.getBoundingClientRect()
            return { left: rect.left, right: rect.right, width: rect.width }
          }),
          scrollAreas,
          userCells,
          actionButtons,
        }
      }, { expectedLongAccount: longAccount, expectedLongUsername: longUsername })

      expect(layout.scrollWidth, `${width}px Admin 页面不应出现页面级横向滚动`).toBeLessThanOrEqual(layout.clientWidth + 1)
      expect(layout.textareaLength, `${width}px 长 CDK 文本应完整保留`).toBe(longCdk.length)
      for (const control of layout.controls) {
        expect(control, `${width}px 关键控件应存在`).not.toBeNull()
        expect(control!.width).toBeGreaterThan(0)
        expect(control!.left).toBeGreaterThanOrEqual(-1)
        expect(control!.right).toBeLessThanOrEqual(layout.clientWidth + 1)
      }
      for (const area of layout.scrollAreas) {
        expect(area, `${width}px 宽表容器应存在`).not.toBeNull()
        expect(area!.width).toBeGreaterThan(0)
        expect(area!.left).toBeGreaterThanOrEqual(-1)
        expect(area!.right).toBeLessThanOrEqual(layout.clientWidth + 1)
        expect(area!.overflowX).toBe('auto')
        expect(area!.scrollWidth).toBeGreaterThanOrEqual(area!.clientWidth)
        if (width < 640 && area!.containsLongAccount) {
          expect(area!.scrollWidth, `${width}px 长内容应由表格自身横向滚动承载`).toBeGreaterThan(area!.clientWidth)
        }
      }
      for (const cell of layout.userCells) {
        expect(cell, `${width}px 四张管理表的用户名格应存在`).not.toBeNull()
        expect(cell!.width).toBeGreaterThan(0)
        expect(cell!.height).toBeGreaterThan(0)
        expect(cell!.scrollWidth, `${width}px 超长用户名不得逸出固定列`).toBeLessThanOrEqual(cell!.clientWidth + 1)
        expect(cell!.fragments.length).toBeGreaterThan(0)
        for (const fragment of cell!.fragments) {
          expect(fragment.width).toBeGreaterThan(0)
          expect(fragment.height).toBeGreaterThan(0)
          expect(fragment.left, `${width}px 用户名文本不得画到单元格左侧`).toBeGreaterThanOrEqual(cell!.left - 1)
          expect(fragment.right, `${width}px 用户名文本不得画到相邻列`).toBeLessThanOrEqual(cell!.right + 1)
        }
      }
      for (const button of layout.actionButtons) {
        expect(button, `${width}px 待复核操作按钮应存在`).not.toBeNull()
        expect(button!.visible).toBe(true)
        expect(button!.width).toBeGreaterThan(0)
        expect(button!.height).toBeGreaterThan(0)
        expect(button!.left).toBeGreaterThanOrEqual(button!.scrollLeft - 1)
        expect(button!.right).toBeLessThanOrEqual(button!.scrollRight + 1)
        expect(button!.textLeft).toBeGreaterThanOrEqual(button!.left - 1)
        expect(button!.textRight).toBeLessThanOrEqual(button!.right + 1)
        expect(button!.hit, `${width}px 超长用户名不得覆盖操作按钮的命中区`).toBe(true)
      }

      await retryButton.click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toBeHidden()
      await terminateButton.click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toBeHidden()
    }
  } finally {
    withE2eDb((db) => {
      db.prepare('DELETE FROM redemptions WHERE id=?').run(redemptionId)
      db.prepare('DELETE FROM daily_settlements WHERE contribution_id=?').run(contributionId)
      db.prepare('DELETE FROM contributions WHERE id=?').run(contributionId)
      db.prepare("DELETE FROM audit_log WHERE action='layout.probe' AND target=?").run(longAccount)
    })
  }
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
