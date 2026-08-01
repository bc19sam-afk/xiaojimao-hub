import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IngestResult } from '../lib/cpa.ts'
import type { SessionUser } from '../lib/session.ts'

// ============================================================================
// P1b-2（collect 侧）：recordIngest 把「认不出身份/没新号」与「真重复」分开，文案诚实。
// 修复前首行 `if (result.duplicate || !result.accountId)` 把两种情况合并成同一句
// 「该账号已被贡献过（重复账号）」——后者其实不是重复，是误导。拆成两分支后：
//   accountId 空 → 「未能确认到新授权的账号…」（诚实，非「交过了」）
//   有 accountId + duplicate → 「这个号交过了，不能再交」（§2.4 文案）
//
// 走 collect 真实导出 finishOAuth：只桩 cpa 边界（返回构造好的 IngestResult），
// recordIngest 是真实执行的。这里用无 state 的 seed:// mock 专用直通，刻意不测试 OAuth session；
// openDb 自动迁移临时库，authFileName 置空使 isolate 早返回不触网络。
//
// ⚠️ 隔离红线：DB_PATH 与 MOCK_CPA_PATH 双双指向临时目录，再动态 import；绝不碰真实 data/。
// 与 normFile 真实客户端测试（test/grok-sub-identity.test.ts，需 MOCK=false）分文件：
// env.mock 每进程固定，两种模式不能同进程共存。
// ============================================================================

let cpa: typeof import('../lib/cpa.ts').cpa
let collect: typeof import('../lib/collect.ts')
let tmpDir: string

function user(id: number): SessionUser {
  return { id, username: `u${id}`, trustLevel: 3 }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-p1b2-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ cpa } = await import('../lib/cpa.ts'))
  collect = await import('../lib/collect.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// 让下一次 collect.finishOAuth 落到指定的 IngestResult（桩 cpa 边界，recordIngest 真实执行）
function stubIngest(result: IngestResult): void {
  cpa.finishOAuth = async () => result
}

// accountId 空（findNew 没找到新号 / 残缺号）→ 诚实「未能确认」，绝非「交过了」
test('recordIngest：认不出账号（accountId 空）→「未能确认」提示，非「交过了」', async () => {
  stubIngest({ accountId: '', email: '', plan: 'unknown', authFileName: '', duplicate: false })
  const r = await collect.finishOAuth(user(9001), 'grok', 'seed://record-ingest-empty')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.error, /未能确认/)
    assert.doesNotMatch(r.error, /交过了/) // 认不出 ≠ 重复，不得误导
  }
})

// 有 accountId + duplicate（真重复）→「这个号交过了，不能再交」
test('recordIngest：真重复（有 accountId + duplicate）→「这个号交过了」', async () => {
  stubIngest({ accountId: 'grok-sub-dup', email: '', plan: 'super', authFileName: '', duplicate: true })
  const r = await collect.finishOAuth(user(9002), 'grok', 'seed://record-ingest-duplicate')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /这个号交过了/)
})
