import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'

let collect: typeof import('../lib/collect.ts')
let db: typeof import('../lib/db.ts').db
let tmpDir: string
let originalFetch: typeof fetch

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-outbound-lock-'))
  process.env.MOCK = 'false'
  process.env.SESSION_SECRET = 'x'.repeat(64)
  process.env.CPA_BASE_URL = 'https://cpa.test/private-url'
  process.env.CPA_MANAGEMENT_KEY = 'test-only-key'
  process.env.WORKER_INTERVAL_MS = '300000'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  const bootstrap = new DatabaseSync(process.env.DB_PATH)
  migrate(bootstrap)
  bootstrap.close()
  ;({ db } = await import('../lib/db.ts'))
  collect = await import('../lib/collect.ts')
  originalFetch = globalThis.fetch
})

after(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('CPA AbortError 后 processPending 的运行锁释放，下一轮不会永久 skipped', async () => {
  const now = Date.now()
  const contribution: Contribution = {
    id: 'timeout-lock',
    linuxdoId: 1,
    username: 'u',
    accountId: 'acct-timeout',
    email: 'u@example.com',
    provider: 'codex',
    plan: 'plus',
    method: 'oauth',
    authFileName: 'codex-timeout.json',
    verifyStatus: 'submitted',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
  }
  db.insertUnique(contribution)

  let calls = 0
  let everyCallHadSignal = true
  globalThis.fetch = (async (_input, init) => {
    calls++
    everyCallHadSignal &&= init?.signal instanceof AbortSignal
    throw new DOMException('aborted with secret URL', 'AbortError')
  }) as typeof fetch

  const first = await collect.processPending()
  const second = await collect.processPending()
  assert.equal(first.inspectFailed, true)
  assert.equal(second.inspectFailed, true)
  assert.notEqual(first.skipped, true)
  assert.notEqual(second.skipped, true, 'finally 必须在 AbortError 后释放 running 锁')
  assert.equal(calls, 2, '两轮都应重新尝试 CPA，而不是被上一轮锁永久挡住')
  assert.equal(everyCallHadSignal, true)
})
