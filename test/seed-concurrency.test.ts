import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { migrate } from '../lib/migrate.ts'

// ============================================================================
// seedDefaults 并发播种竞态（TOCTOU）回归。next build 并行拉起多个 worker 进程，各自
// 显式 bootstrap 进程并发调用 seedDefaults 打同一 data/app.db；每块「SELECT COUNT==0 then INSERT」非原子，
// 两进程同读 count=0 再各插 → point_rules/usage_rates(UNIQUE) 撞唯一键崩溃、build 挂；
// redeem_items(无唯一键) 静默翻倍(4→8)；app_config(key PRIMARY KEY) 同样会撞。
// 修复＝整个 seedDefaults 包 BEGIN IMMEDIATE 单事务：先到者持写锁播完提交，后到者阻塞至提交后
// 读到 count>0 全部跳过。
//
// 复现的难点：种子临界区仅微秒级，进程到达抖动（毫秒级）远大于它 → 单纯并发起进程极难撞上。
// 故本测「紧对齐」：每个子进程先 import db.ts（其单例连接保持惰性，不碰 target）拿到导出的
// seedDefaults，再开 target 连接、写 ready 文件、自旋等 GO；父进程见 N 个
// ready 齐了才落 GO，把所有子进程同刻放行去调真实 seedDefaults(target)——临界区对齐，破损版必撞。
// 断言：① 无子进程崩溃（全 exit 0）；② 种子表行数精确——redeem_items 恒 4（竞态曾 4→8）、
// point_rules=7、usage_rates=5、app_config observe_window_ms 恰 1 行。跑多轮加固。
// ⚠️ 隔离红线：target DB_PATH 全程指向临时目录，绝不碰真实 data/app.db。
// ============================================================================

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const setupPath = path.join(root, 'test', 'setup.mjs') // 子进程 --import：装 .ts 解析钩子
const dbModule = path.join(root, 'lib', 'db.ts') // 子进程 import 目标（拿导出的 seedDefaults）

const N = 10 // 每轮并发子进程数（紧对齐下 ≥6 即稳撞，取 10 留裕度）
const ROUNDS = 3 // 轮数：紧对齐单轮即近乎必撞，多轮再加固检出

let tmpDir: string
let dbPath: string
let keepAlive: DatabaseSync // 全程持开：保住 target 的 -wal/-shm 存活，供跨轮 reset 与读行数

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-seed-conc-'))
  dbPath = path.join(tmpDir, 'app.db')
  keepAlive = new DatabaseSync(dbPath)
  keepAlive.exec('PRAGMA busy_timeout = 5000')
  keepAlive.exec('PRAGMA journal_mode = WAL')
  migrate(keepAlive) // 预迁移：建好空 schema，子进程只在 seedDefaults 抢
})

after(() => {
  keepAlive.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// 子进程脚本：import db.ts（单例连接保持惰性，不碰 target）取 seedDefaults → 开 target 连接 →
// 写 ready → 自旋等 GO → 调真实 seedDefaults(target)。撞唯一键则抛 → 进程非零退出；redeem 翻倍不抛。
const CHILD_SRC = [
  "import fs from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  "import { DatabaseSync } from 'node:sqlite'",
  'const { TARGET, BARRIER, DB_MODULE, READY } = process.env',
  'const { seedDefaults } = await import(pathToFileURL(DB_MODULE).href)',
  'const t = new DatabaseSync(TARGET)',
  "t.exec('PRAGMA busy_timeout = 5000')",
  "t.exec('PRAGMA journal_mode = WAL')",
  "fs.writeFileSync(READY, '')",
  'function sleep(ms){ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms) }',
  'for (let i=0;i<10000 && !fs.existsSync(BARRIER);i++) sleep(1)',
  'seedDefaults(t)',
  't.close()',
  '',
].join('\n')

// 直连 keepAlive 点行数（无活动事务，每次读到最新已提交）
function count(t: string): number {
  return (keepAlive.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
}

test('seedDefaults 并发：N 进程紧对齐同刻播种 → 无崩溃、种子表行数精确（redeem_items 恒 4）', async () => {
  const childPath = path.join(tmpDir, 'seed-child.mjs')
  fs.writeFileSync(childPath, CHILD_SRC)

  for (let r = 0; r < ROUNDS; r++) {
    // 每轮清空种子表，令子进程重跑一整场竞态
    keepAlive.exec(
      'DELETE FROM point_rules; DELETE FROM usage_rates; DELETE FROM redeem_items; DELETE FROM app_config',
    )
    const roundDir = path.join(tmpDir, `r${r}`)
    const readyDir = path.join(roundDir, 'ready')
    fs.mkdirSync(readyDir, { recursive: true })
    const barrier = path.join(roundDir, 'GO')

    const procs = Array.from({ length: N }, (_v, i) => {
      const c = spawn(process.execPath, ['--import', setupPath, childPath], {
        cwd: root,
        env: {
          ...process.env,
          DB_PATH: ':memory:', // 子进程单例 openDb 用内存库，绝不碰 target
          MOCK: 'true',
          TARGET: dbPath,
          DB_MODULE: dbModule,
          BARRIER: barrier,
          READY: path.join(readyDir, String(i)),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      c.stderr.on('data', (b) => (stderr += b))
      return new Promise<{ code: number | null; stderr: string }>((res) =>
        c.on('exit', (code) => res({ code, stderr })),
      )
    })

    // 等所有子进程都写好 ready（＝都到了 seedDefaults 门口）再统一放行，逼出临界区对齐
    const deadline = Date.now() + 15_000
    while (fs.readdirSync(readyDir).length < N) {
      if (Date.now() > deadline) throw new Error(`第 ${r} 轮：子进程未在 15s 内就绪`)
      await sleep(10)
    }
    fs.writeFileSync(barrier, '1')
    const results = await Promise.all(procs)

    const crashed = results.filter((x) => x.code !== 0)
    assert.equal(
      crashed.length,
      0,
      `第 ${r} 轮：所有子进程应正常退出（并发播种不撞唯一键）；失败 ${crashed.length}/${N}，样例 stderr：\n${crashed[0]?.stderr ?? ''}`,
    )
    assert.equal(count('redeem_items'), 4, `第 ${r} 轮：redeem_items 应恒 4（>4＝竞态静默翻倍）`)
    assert.equal(count('point_rules'), 7, `第 ${r} 轮：point_rules 应为 7`)
    assert.equal(count('usage_rates'), 5, `第 ${r} 轮：usage_rates 应为 5`)
    assert.equal(
      (
        keepAlive
          .prepare("SELECT COUNT(*) AS n FROM app_config WHERE key='observe_window_ms'")
          .get() as { n: number }
      ).n,
      1,
      `第 ${r} 轮：app_config observe_window_ms 应恰 1 行`,
    )
  }
})

// 公共 API 复核（呼应验收：listRedeemItems().length===4）：并发播种后经单例连接读，仍恰 4 条 / 7 条
test('并发播种后 db.listRedeemItems().length === 4（公共 API 复核）', async () => {
  process.env.DB_PATH = dbPath
  process.env.MOCK = 'true'
  const { db } = await import('../lib/db.ts')
  assert.equal(db.listRedeemItems().length, 4)
  assert.equal(db.listPointRules().length, 7)
})
