import { expect, test, type Page, type Route } from '@playwright/test'

const reviewRow = {
  id: 'review-ui-r1',
  linuxdoId: 1,
  username: 'preview',
  provider: 'grok',
  accountId: 'grok-preview-account',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
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
  await login(page)

  for (const width of [320, 375, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.reload()

    const buttons = page.locator('[data-provider-option]')
    await expect(buttons).toHaveCount(3)
    const bounds = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width }
      }),
    )
    const pageWidth = await page.evaluate(() => document.documentElement.clientWidth)
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)

    expect(scrollWidth, `${width}px 页面不应横向溢出`).toBeLessThanOrEqual(pageWidth + 1)
    for (const rect of bounds) {
      expect(rect.width).toBeGreaterThan(0)
      expect(rect.left).toBeGreaterThanOrEqual(0)
      expect(rect.right).toBeLessThanOrEqual(pageWidth + 1)
    }
  }

  const grok = page.getByRole('button', { name: 'Grok SuperGrok' })
  await grok.focus()
  await page.keyboard.press('Enter')
  await expect(grok).toHaveAttribute('aria-pressed', 'true')
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
  await mockReviewQueue(page, async (route) => {
    reviewPosts += 1
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, review: [] }) })
  })
  let deletePosts = 0
  await page.route('**/api/admin/redeem-items*', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback()
      return
    }
    deletePosts += 1
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '暂时无法删除，请稍后重试' }),
    })
  })

  await openAdmin(page)

  await page.getByRole('button', { name: /终止人工复核/ }).click()
  const terminateDialog = page.getByRole('dialog', { name: /确认终止/ })
  const confirmTerminate = terminateDialog.getByTestId('confirm-action-button')
  await confirmTerminate.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await expect(confirmTerminate).toBeDisabled()
  await expect(terminateDialog).toBeHidden()
  expect(reviewPosts).toBe(1)

  const deleteTrigger = page.getByRole('button', { name: /删除兑换项/ }).first()
  await deleteTrigger.click()
  const deleteDialog = page.getByRole('dialog', { name: /确认删除兑换项/ })
  const confirmDelete = deleteDialog.getByRole('button', { name: /确认删除/ })
  await confirmDelete.click()
  await expect(deleteDialog.getByRole('alert')).toContainText('暂时无法删除，请稍后重试')
  await expect(deleteDialog).toBeVisible()
  await expect(confirmDelete).toBeEnabled()
  await expect(deleteTrigger).toBeVisible()
  expect(deletePosts).toBe(1)
  await confirmDelete.click()
  await expect(deleteDialog.getByRole('alert')).toContainText('暂时无法删除，请稍后重试')
  expect(deletePosts).toBe(2)
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
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, summary: '进程暂不可用' }) })
    }
  })
  await page.route('**/api/ready', async (route) => {
    readyCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 800))
    if (readyCalls === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, summary: '数据库尚未就绪', detail: 'secret-internal-detail' }),
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
  await expect(page.getByText('secret-internal-detail')).toHaveCount(0)

  const refresh = page.getByTestId('refresh-system-status')
  await refresh.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await expect(refresh).toBeDisabled()
  await expect(live).toContainText('检查中')
  await expect(ready).toContainText('检查中')
  await expect(live).toContainText('不可用')
  await expect(ready).toContainText('可用')
  expect(healthCalls).toBe(2)
  expect(readyCalls).toBe(2)
  await expect(page.getByText(/最近检查/)).toBeVisible()
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
