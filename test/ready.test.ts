import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// ============================================================================
// P6-R2 ①：readiness 探针（lib/ready.ts）
//
// 判据两条：DB 只读探活 + schema 版本 === LATEST_VERSION。任一不满足 → false（不抛）。
//
// ⚠️ 隔离红线：DB_PATH 指向临时目录后再动态 import lib/db.ts（顶部值导入会在设 env 前开真实库）。
// ⚠️ MOCK=true ⇒ openDb 自动跑 migrate ⇒ 拿到的就是「全新迁移到最新版」的库。
// ============================================================================

let checkReady: typeof import('../lib/ready.ts').checkReady
let LATEST_VERSION: number
let tmpDir: string
let dbPath: string

// checkReady 未就绪时会 console.error（服务端日志），测试里静音以免污染输出；返回还原函数。
function muteError(): () => void {
  const orig = console.error
  console.error = () => {}
  return () => {
    console.error = orig
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ready-'))
  dbPath = path.join(tmpDir, 'app.db')
  process.env.MOCK = 'true'
  process.env.DB_PATH = dbPath
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ checkReady } = await import('../lib/ready.ts'))
  ;({ LATEST_VERSION } = await import('../lib/migrate.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ⚠️ 不要加 afterEach 删库重建：lib/ready.ts 里 `await import('./db')` 首次调用后模块被缓存，
//    那条连接绑在旧文件描述符上，删文件后连接就悬空了。每条测试末尾自己把 schema_version 改回去。

// ① 全新迁移库（MOCK 下 openDb 自动 migrate 到 LATEST_VERSION）→ 就绪
test('ready：全新迁移到最新版的库 → true', async () => {
  assert.equal(await checkReady(), true)
})

// ② schema 版本落后 → 未就绪。直接改库里的 schema_version（另开连接写，应用那条连接读得到——
//    同一文件、WAL 下新事务可见已提交的写），验证探针读的是**当下**的库状态而非启动时的缓存。
test('ready：schema_version 落后于 LATEST_VERSION → false', async () => {
  const w = new DatabaseSync(dbPath)
  w.exec('PRAGMA busy_timeout = 5000')
  w.prepare('UPDATE schema_version SET version = ?').run(LATEST_VERSION - 1)
  w.close()
  const unmute = muteError()
  try {
    assert.equal(await checkReady(), false)
  } finally {
    unmute()
  }
  // 还原，不影响后续测试
  const r = new DatabaseSync(dbPath)
  r.exec('PRAGMA busy_timeout = 5000')
  r.prepare('UPDATE schema_version SET version = ?').run(LATEST_VERSION)
  r.close()
  assert.equal(await checkReady(), true)
})

// ③ schema 版本超前（代码回滚场景）→ 未就绪。
//    与 assertSchemaCurrent 的差别：那个启动期只 warn 放行（向后兼容纪律），
//    readiness 取严格相等——运行期版本不一致就该摘流量。这条钉住「不是照抄 assertSchemaCurrent」。
test('ready：schema_version 超前于 LATEST_VERSION → false（严格相等，区别于启动期守卫）', async () => {
  const w = new DatabaseSync(dbPath)
  w.exec('PRAGMA busy_timeout = 5000')
  w.prepare('UPDATE schema_version SET version = ?').run(LATEST_VERSION + 1)
  w.close()
  const unmute = muteError()
  try {
    assert.equal(await checkReady(), false)
  } finally {
    unmute()
  }
  const r = new DatabaseSync(dbPath)
  r.exec('PRAGMA busy_timeout = 5000')
  r.prepare('UPDATE schema_version SET version = ?').run(LATEST_VERSION)
  r.close()
  assert.equal(await checkReady(), true)
})

// ④ 库坏（schema_version 表被删 → readSchemaVersion 返 null）→ false 且**不抛**。
//    探针绝不能因为被探测对象坏了而 500。
test('ready：schema_version 表缺失 → false 不抛', async () => {
  const w = new DatabaseSync(dbPath)
  w.exec('PRAGMA busy_timeout = 5000')
  w.exec('ALTER TABLE schema_version RENAME TO schema_version_bak')
  w.close()
  const unmute = muteError()
  try {
    assert.doesNotThrow(async () => await checkReady())
    assert.equal(await checkReady(), false)
  } finally {
    unmute()
  }
  const r = new DatabaseSync(dbPath)
  r.exec('PRAGMA busy_timeout = 5000')
  r.exec('ALTER TABLE schema_version_bak RENAME TO schema_version')
  r.close()
  assert.equal(await checkReady(), true)
})

// ⑤ schema_version 多行（readSchemaVersion 会抛）→ false 不抛。
//    覆盖「探活链路里任意一环抛异常」的兜底 catch。
test('ready：schema_version 多行（readSchemaVersion 抛）→ false 不抛', async () => {
  const w = new DatabaseSync(dbPath)
  w.exec('PRAGMA busy_timeout = 5000')
  w.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_VERSION)
  w.close()
  const unmute = muteError()
  try {
    assert.doesNotThrow(async () => await checkReady())
    assert.equal(await checkReady(), false)
  } finally {
    unmute()
  }
  const r = new DatabaseSync(dbPath)
  r.exec('PRAGMA busy_timeout = 5000')
  r.exec('DELETE FROM schema_version')
  r.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_VERSION)
  r.close()
  assert.equal(await checkReady(), true)
})
