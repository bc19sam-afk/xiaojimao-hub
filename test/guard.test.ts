import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, assertSchemaCurrent, LATEST_VERSION } from '../lib/migrate.ts'

// ⚠️ 测试库隔离（红线）：config 测试要用 lib/db.ts 的全局单例连接，
// 先把 DB_PATH 指向临时目录，再动态 import，绝不读写真实开发库。
let db: typeof import('../lib/db.ts').db
let tmpDir: string

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-guard-'))
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  ;({ db } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ① 全新空库：assertSchemaCurrent 直接 throw（含 migrate 指引），且保持只读不建表
test('守卫：全新空库 assertSchemaCurrent 抛错且信息含 npm run migrate', () => {
  const d = new DatabaseSync(':memory:')
  assert.throws(() => assertSchemaCurrent(d), /npm run migrate/)
  // 校验函数只读：不应有建 schema_version 表的副作用
  const row = d
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get()
  assert.equal(row, undefined)
  d.close()
})

// ② 跑完 migrate 后：版本相等 → 通过
test('守卫：migrate 后 assertSchemaCurrent 通过', () => {
  const d = new DatabaseSync(':memory:')
  const version = migrate(d)
  assert.equal(version, LATEST_VERSION)
  assert.doesNotThrow(() => assertSchemaCurrent(d))
  d.close()
})

// ③ 版本超前（代码回滚场景）：不 throw，放行
test('守卫：schema 版本超前于代码时放行不抛错', () => {
  const d = new DatabaseSync(':memory:')
  migrate(d)
  d.prepare('UPDATE schema_version SET version = ?').run(LATEST_VERSION + 1)
  assert.doesNotThrow(() => assertSchemaCurrent(d))
  d.close()
})

// ④ app_config KV：往返读写、覆盖写生效、不存在的 key 返回 null
test('app_config：setConfig/getConfig 往返、覆盖写生效、缺失键为 null', () => {
  assert.equal(db.getConfig('guard-missing'), null)
  db.setConfig('guard-k', 'v1')
  assert.equal(db.getConfig('guard-k'), 'v1')
  db.setConfig('guard-k', 'v2') // UPSERT 覆盖
  assert.equal(db.getConfig('guard-k'), 'v2')
})
