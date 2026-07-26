import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================================
// P6-R2 复审第 4 条：HEARTBEAT_URL「http 开头但不是合法 URL」也必须在**配置期**拦下
//
// 为什么单独一条：原实现只用 `/^https?:\/\//` 前缀正则判定，`https://ho st/<uuid>` 这种带空格的
// 值照样放行 → 一路流到 pingHeartbeat 里的 fetch → 抛
// `TypeError: Failed to parse URL from https://ho st/<uuid>`，而 catch 里 console.warn 会把
// **整个错误对象**打进日志，含 uuid 型密钥的完整 URL 就此泄露——正是 §8 要防的事。
// 修法：用 new URL() 真解析，不合法就地按未配置处理，绝不让它有机会进 fetch 的报错。
//
// env 是模块级单例、每进程固定 ⇒ 又得单开一个文件（同 heartbeat-disabled.test.ts 的理由）。
// ============================================================================

const SECRET = 'a1b2c3d4-SECRET-uuid'
let pingHeartbeat: typeof import('../lib/worker.ts').pingHeartbeat
let env: typeof import('../lib/env.ts').env
let tmpDir: string
const warns: string[] = []

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-hb-bad-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  // http 开头（前缀正则会放行）但含空格 ⇒ 不是合法 URL
  process.env.HEARTBEAT_URL = `https://ho st/${SECRET}`
  const origWarn = console.warn
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
  try {
    ;({ env } = await import('../lib/env.ts'))
    ;({ pingHeartbeat } = await import('../lib/worker.ts'))
  } finally {
    console.warn = origWarn
  }
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('前置：该值确实能骗过「http(s) 开头」的前缀正则，但不是合法 URL', () => {
  const raw = process.env.HEARTBEAT_URL as string
  assert.ok(/^https?:\/\//.test(raw), '前置：前缀正则会放行它')
  assert.throws(() => new URL(raw), '前置：它不是合法 URL')
})

test('复审4：http 开头但非法的 URL → 配置期就判为空（视为关闭）', () => {
  assert.equal(
    env.worker.heartbeatUrl,
    '',
    '🔴 放行非法 URL 会让它流到 fetch，报错信息里带出整条含密钥的 URL',
  )
})

test('复审4：配置期告警不回显该值（§8 脱敏）', () => {
  const hits = warns.filter((w) => w.includes('HEARTBEAT_URL'))
  assert.equal(hits.length, 1, '应有且仅有一条 HEARTBEAT_URL 告警')
  assert.ok(!hits[0].includes(SECRET), '🔴 告警不得回显配置值（含 uuid 型密钥）')
  assert.ok(!hits[0].includes('ho st'), '🔴 主机名部分也不该回显')
})

// 🔴 核心：整条链路走一遍，确认**任何输出**都不含那段密钥。
//    修复前：pingHeartbeat 会真的调 fetch → TypeError 里带整条 URL → console.warn 打出去。
test('复审4：走完整条心跳链路，stdout/stderr 都不含密钥段', async () => {
  const logs: string[] = []
  const origWarn = console.warn
  const origErr = console.error
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(' '))
  let fetchCalls = 0
  try {
    // 用**真 fetch**：正是它的 TypeError 带出了 URL。若 heartbeatUrl 已判空则根本不会走到这
    const wrapped = ((...args: Parameters<typeof fetch>) => {
      fetchCalls++
      return fetch(...args)
    }) as typeof fetch
    await pingHeartbeat(true, 1_000_000, wrapped)
  } finally {
    console.warn = origWarn
    console.error = origErr
  }
  assert.equal(fetchCalls, 0, '非法 URL 不该走到 fetch')
  const all = logs.join('\n')
  assert.ok(!all.includes(SECRET), `🔴 日志泄露了密钥段：${all}`)
})
