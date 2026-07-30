import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

// ============================================================================
// P6-R2 ①：readiness 探针（lib/ready.ts）
//
// 判据：常驻连接、DB_PATH 存在且仍是启动 inode、fresh 磁盘连接、两侧 schema 版本。任一失败 → false。
//
// ⚠️ 隔离红线：DB_PATH 指向临时目录后再动态 import lib/db.ts（顶部值导入会在设 env 前开真实库）。
// ⚠️ MOCK=true ⇒ openDb 自动跑 migrate ⇒ 拿到的就是「全新迁移到最新版」的库。
// ============================================================================

let checkReady: typeof import('../lib/ready.ts').checkReady
let LATEST_VERSION: number
let tmpDir: string
let dbPath: string

const READY_CHILD_SOURCE = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checkReady } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../lib/ready.ts')).href)}

const dbPath = process.env.DB_PATH
assert.ok(dbPath)
assert.equal(await checkReady(), true, '前置：替换/删除前必须已打开健康的常驻连接')

if (process.env.READY_SCENARIO === 'replace') {
  const replacement = path.join(path.dirname(dbPath), 'replacement.db')
  const source = new DatabaseSync(dbPath)
  try {
    source.prepare('VACUUM INTO ?').run(replacement)
  } finally {
    source.close()
  }
  fs.renameSync(replacement, dbPath)
} else if (process.env.READY_SCENARIO === 'unlink') {
  fs.rmSync(dbPath, { force: true })
  assert.equal(fs.existsSync(dbPath), false, '前置：数据库路径确实已不存在')
} else if (process.env.READY_SCENARIO === 'truncate') {
  fs.truncateSync(dbPath, 0)
  assert.equal(fs.statSync(dbPath).size, 0, '前置：保持同 inode，但磁盘库已被截空')
} else {
  throw new Error('未知 READY_SCENARIO：' + process.env.READY_SCENARIO)
}

console.error = () => {}
assert.equal(await checkReady(), false)
`

function runIsolatedReadyScenario(scenario: 'replace' | 'unlink' | 'truncate'): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xjm-ready-${scenario}-`))
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        path.resolve(import.meta.dirname, 'setup.mjs'),
        '--input-type=module',
        '-e',
        READY_CHILD_SOURCE,
      ],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          MOCK: 'true',
          DB_PATH: path.join(dir, 'app.db'),
          MOCK_CPA_PATH: path.join(dir, 'mock-cpa.json'),
          READY_SCENARIO: scenario,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    assert.equal(
      result.status,
      0,
      `隔离 readiness 场景 ${scenario} 失败：\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

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

// ⑥ 原子替换成另一份**同 schema 版本**的合法库：常驻连接仍绑旧 inode、若只读连接缓存会继续报 true。
// readiness 必须同时核对磁盘路径仍指向启动时打开的同一个数据库文件，不能只比较版本号。
test('ready：app.db 被同版本合法库原子替换 → false（不能继续服务旧 inode）', () => {
  runIsolatedReadyScenario('replace')
})

// ⑦ 删除路径后，SQLite 的常驻连接仍能从 page cache 读旧 schema，甚至继续向已 unlink 的 inode/WAL 写。
// 这是最危险的假绿：进程活着时请求成功，重启后写入全部消失。放在本文件最后，因为旧连接不可重新绑定。
test('ready：app.db 路径被删除 → false（常驻连接缓存仍可读也不能放行）', () => {
  runIsolatedReadyScenario('unlink')
})

// ⑧ 原地截断不会改变 dev/inode，常驻连接仍可能从 page cache 读出旧 schema；必须靠 fresh 磁盘连接兜住。
test('ready：app.db 保持同 inode 但磁盘内容被截空 → false', () => {
  runIsolatedReadyScenario('truncate')
})
