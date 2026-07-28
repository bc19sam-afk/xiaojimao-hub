import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Contribution } from '../lib/db.ts'
import { readinessResult } from '../lib/readiness.ts'

let db: typeof import('../lib/db.ts').db
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ui-r1-overview-'))
  process.env.MOCK = 'true'
  process.env.WORKER_ENABLED = 'false'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function contribution(id: string, verifyStatus: Contribution['verifyStatus']): Contribution {
  const now = Date.now()
  return {
    id,
    linuxdoId: 1,
    username: 'preview',
    accountId: `account-${id}`,
    email: '',
    provider: 'codex',
    plan: 'plus',
    method: 'oauth',
    authFileName: `${id}.json`,
    verifyStatus,
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
  }
}

test('后台概览使用数据库真实总数，不从最新 50 条页面数组猜测', () => {
  for (let i = 0; i < 55; i++) {
    db.insertUnique(contribution(`pooled-${i}`, 'pooled'))
    db.createRedemption({
      id: `pending-${i}`,
      linuxdoId: 1,
      itemId: 1,
      itemName: `待处理-${i}`,
      cost: 1,
      status: 'pending',
    })
  }
  db.insertUnique(contribution('review', 'needs_review'))
  db.createRedemption({ id: 'fulfilled', linuxdoId: 1, itemId: 1, itemName: '已完成', cost: 1, status: 'fulfilled' })

  assert.deepEqual(db.adminOverview(), {
    pooledAccounts: 55,
    needsReview: 1,
    pendingRedemptions: 55,
    enabledRedeemItems: db.listRedeemItems(true).length,
  })
  assert.equal(db.listContributionsAdmin(50).length, 50)
  assert.equal(db.listRedemptionsAdmin(50).length, 50)
  assert.doesNotThrow(() => db.assertReady())
})

test('readiness 只在依赖探活成功时返回 200，异常返回脱敏 503', () => {
  assert.deepEqual(readinessResult(() => {}), { status: 200, body: { ok: true } })
  const failed = readinessResult(() => {
    throw new Error('sqlite path=/private/secret.db token=secret')
  })
  assert.deepEqual(failed, {
    status: 503,
    body: { ok: false, code: 'DATABASE_NOT_READY', summary: '数据库尚未就绪' },
  })
  assert.equal(JSON.stringify(failed).includes('private'), false)
  assert.equal(JSON.stringify(failed).includes('secret'), false)
})
