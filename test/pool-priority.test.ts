import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================================
// 对接-R2b 入池优先级（§2.5/§7.1/§7.3）配置层单测：
//   A getPoolPriority/setPoolPriority —— 缺省 10 / config 覆盖 / 钳负 0 / 脏值回落 / 0 值保真
//   B auditPoolPriority（纯函数）—— action/target/old/new 正确
//   ⚠️ 隔离红线（仿 config-p4r2.test.ts）：DB_PATH / MOCK_CPA_PATH 指临时目录再**动态 import**；
//      绝不在顶部值导入 lib/db.ts（会在设 env 前开真实库、破隔离）。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let audit: typeof import('../lib/audit.ts')
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-pool-prio-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  audit = await import('../lib/audit.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// A1 缺省 10 / config 覆盖 / 钳负 0（须先于其它 pool_priority 改动：验缺省要求还没写过键）
test('A1 getPoolPriority：缺省 10 / config 覆盖 / 钳负 0', () => {
  assert.equal(db.getPoolPriority(), 10, '无 config 键 → 缺省 10')
  db.setPoolPriority(20)
  assert.equal(db.getPoolPriority(), 20, 'config 覆盖')
  db.setPoolPriority(-3)
  assert.equal(db.getPoolPriority(), 0, '负值下钳 0')
})

// A2 脏 config 值 → 回落 10（即便有人绕 setter 直写脏值，判定仍安全）
test('A2 getPoolPriority：脏 config 值回落 10', () => {
  db.setConfig('pool_priority', 'xyz') // 绕过 setter 直写脏值
  assert.equal(db.getPoolPriority(), 10, '脏值 → 回落 10')
})

// A3 0 值保真：setPoolPriority(0) → 读回 0（?? / || 别把 0 吞成默认；0＝合法最低优先级）
test('A3 setPoolPriority(0)：0 值保真、不被吞成默认', () => {
  db.setPoolPriority(0)
  assert.equal(db.getPoolPriority(), 0, '0 是合法值（越大越优先，0＝最低），不得回落缺省 10')
})

// B1 auditPoolPriority：action/target/old/new 为标量（无 PII）
test('B1 audit：pool_priority.set old/new 为标量', () => {
  const e = audit.auditPoolPriority(10, 20)
  assert.equal(e.action, 'pool_priority.set')
  assert.equal(e.target, 'pool_priority')
  assert.equal(e.old, 10)
  assert.equal(e.new, 20)
})
