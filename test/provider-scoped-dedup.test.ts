import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AuthFile, CpaClient } from '../lib/cpa.ts'
import type { SessionUser } from '../lib/session.ts'

// ============================================================================
// P1c：收号链路全线按 (provider, account_id) 判重（而非全局 accountId）。
// account_id 命名空间按 provider 独立——跨 provider 撞同一 id 是合法新号，不能误拒。
//
// ⚠️ 隔离红线（升级版）：除 DB_PATH（既有手法）外，mock CPA 会写
//    process.cwd()/data/mock-cpa.json。这里把 DB_PATH 与 MOCK_CPA_PATH 双双指向临时目录，
//    再动态 import——绝不碰真实 data/ 下任何文件。node --test 每文件独立进程，env 改动不外泄。
// ============================================================================

let collect: typeof import('../lib/collect.ts')
let db: typeof import('../lib/db.ts').db
let findNew: typeof import('../lib/cpa.ts').findNew
let tmpDir: string

function user(id: number): SessionUser {
  return { id, username: `u${id}`, trustLevel: 3 }
}

// mock CPA 客户端桩：findNew 只用到 listAuthFiles
function stubClient(files: AuthFile[]): CpaClient {
  return { listAuthFiles: async () => files } as unknown as CpaClient
}
function authFile(over: Partial<AuthFile>): AuthFile {
  return { name: 'f.json', accountId: 'acc', email: '', plan: 'unknown', disabled: true, ...over }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-p1c-'))
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  ;({ findNew } = await import('../lib/cpa.ts'))
  collect = await import('../lib/collect.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ① 端到端跨 provider 放行：同一 accountId 的号，codex 交一次、claude 再交一次 → 两次都入库，两行。
test('① 端到端：同一 accountId 跨 provider（codex+claude）都成功入库，DB 两行', async () => {
  const uid = 3101
  // 同一 redirectUrl seed → mock 落同一 accountId（provider 无关），模拟同一上游号跨两站贡献
  const r1 = await collect.finishOAuth(user(uid), 'codex', 'seed://shared-account-1')
  const r2 = await collect.finishOAuth(user(uid), 'claude', 'seed://shared-account-1')
  if (!r1.ok) assert.fail(`codex 应成功，却报错：${r1.error}`)
  if (!r2.ok) assert.fail(`claude 应成功（跨 provider 同 id 不算重复），却报错：${r2.error}`)
  assert.equal(r1.contribution.accountId, r2.contribution.accountId) // 确系同一 accountId
  assert.equal(r1.contribution.provider, 'codex')
  assert.equal(r2.contribution.provider, 'claude')

  const mine = db.byUser(uid)
  assert.equal(mine.length, 2)
  assert.deepEqual(
    mine.map((c) => c.provider).sort(),
    ['claude', 'codex'],
  )
})

// ② 端到端同 provider 判重：同 provider 同 accountId 第二次提交 → 拒绝，DB 仍一行。
test('② 端到端：同 provider 同 accountId 二次提交被拒（该账号已被贡献过），DB 仍一行', async () => {
  const uid = 3102
  const a = await collect.finishOAuth(user(uid), 'codex', 'seed://same-account-2')
  const b = await collect.finishOAuth(user(uid), 'codex', 'seed://same-account-2')
  if (!a.ok) assert.fail(`首次应成功，却报错：${a.error}`)
  assert.equal(b.ok, false)
  if (!b.ok) assert.match(b.error, /已被贡献过/)

  const mine = db.byUser(uid).filter((c) => c.provider === 'codex' && c.accountId === a.contribution.accountId)
  assert.equal(mine.length, 1)
})

// ②b RT 路径同 provider 判重（ingestRT 仅 codex，seed 取自 rt，天然幂等）。
test('②b 端到端：同一 RT 二次提交被拒，DB 仍一行', async () => {
  const uid = 3103
  const a = await collect.ingestRT(user(uid), 'refresh-token-xyz-123456')
  const b = await collect.ingestRT(user(uid), 'refresh-token-xyz-123456')
  if (!a.ok) assert.fail(`首次应成功，却报错：${a.error}`)
  assert.equal(b.ok, false)
  if (!b.ok) assert.match(b.error, /已被贡献过/)

  const mine = db.byUser(uid).filter((c) => c.accountId === a.contribution.accountId)
  assert.equal(mine.length, 1)
})

// ③ findNew 不拿错号：候选里同时有新落的 codex 与 claude 文件（都不在各自 known），
//    findNew(codex) 只能拿 codex 的那个，绝不抓 claude 的（哪怕 claude 排在前面/也是新号）。
test('③ findNew 按 provider 过滤候选：findNew(codex) 只取 codex 文件，不抓 claude', async () => {
  const files = [
    // claude 排在最前且也是「新号」——旧逻辑（无 provider 过滤）会先命中它 → 拿错号
    authFile({ name: 'claude-accB.json', accountId: 'accB', provider: 'claude' }),
    authFile({ name: 'codex-accA.json', accountId: 'accA', provider: 'codex' }),
    authFile({ name: 'mystery-accC.json', accountId: 'accC', provider: undefined }), // 识别不出 → 应保守跳过
  ]
  const client = stubClient(files)

  const codex = await findNew(client, 'codex', new Set<string>())
  assert.equal(codex.duplicate, false)
  assert.equal(codex.accountId, 'accA')
  assert.equal(codex.authFileName, 'codex-accA.json')

  const claude = await findNew(client, 'claude', new Set<string>())
  assert.equal(claude.accountId, 'accB')

  // grok 无候选文件 → duplicate（保守：没有本 provider 的新号）
  const grok = await findNew(client, 'grok', new Set<string>())
  assert.equal(grok.duplicate, true)
  assert.equal(grok.accountId, '')
})

// ④ known 按 provider 划界：cpamp 同时有 codex-accX 与 claude-accX；claude 的已知集合为空
//    （即便全局已有 codex 的 accX）→ findNew(claude) 放行 accX；反证：若把 accX 误当 claude 已知则被拦。
test('④ findNew 的 known 按 provider：claude 的空 known 放行 accX，全局式误传则被拦', async () => {
  const files = [
    authFile({ name: 'codex-accX.json', accountId: 'accX', provider: 'codex' }),
    authFile({ name: 'claude-accX.json', accountId: 'accX', provider: 'claude' }),
  ]
  const client = stubClient(files)

  // provider 划界后：claude 的 known 不含 accX（那是 codex 的号）→ 放行
  const ok = await findNew(client, 'claude', new Set<string>())
  assert.equal(ok.duplicate, false)
  assert.equal(ok.accountId, 'accX')
  assert.equal(ok.authFileName, 'claude-accX.json')

  // 反证：若沿用旧的「全局 known」把 accX 传进来 → 被误判重复（正是本单要修的 bug）
  const blocked = await findNew(client, 'claude', new Set<string>(['accX']))
  assert.equal(blocked.duplicate, true)
})

// ⑤ 底座：db.accountIdsFor(provider) 只返回该 provider 的 accountId。
test('⑤ db.accountIdsFor(provider) 按 provider 过滤', () => {
  const uid = 3105
  db.insertUnique({
    id: 'p1c-cx', linuxdoId: uid, username: 'u', accountId: 'scope-accX', email: 'e@x.com',
    provider: 'codex', plan: 'plus', method: 'oauth', authFileName: 'codex-scope-accX.json',
    verifyStatus: 'pending', points: 0, rewardStatus: 'none', rewardText: '', rewardNote: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  })
  db.insertUnique({
    id: 'p1c-cl', linuxdoId: uid, username: 'u', accountId: 'scope-accY', email: 'e@x.com',
    provider: 'claude', plan: 'pro', method: 'oauth', authFileName: 'claude-scope-accY.json',
    verifyStatus: 'pending', points: 0, rewardStatus: 'none', rewardText: '', rewardNote: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  })
  const codexIds = db.accountIdsFor('codex')
  assert.ok(codexIds.includes('scope-accX'))
  assert.ok(!codexIds.includes('scope-accY')) // claude 的号不混入
  assert.ok(db.accountIdsFor('claude').includes('scope-accY'))
})
