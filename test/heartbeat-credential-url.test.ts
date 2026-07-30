import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================================
// P6-R2 复审三轮第 4 条：HEARTBEAT_URL 带 basic-auth 凭证也必须在**配置期**拦下
//
// 与上一条（heartbeat-malformed-url.test.ts）是同一漏洞的两个入口：那条堵「不合法的 URL」，
// 这条堵「**合法但带凭证**」。`https://user:pw@host/<uuid>` 能过 new URL()，却会被 fetch 拒绝：
//   TypeError: Request cannot be constructed from a URL that includes credentials: <整条 URL>
// 明文密码与 uuid 段一起进了错误对象，又被 pingHeartbeat 的 console.warn(e) 打进日志——§8 红线。
// 修法：配置期判 username/password 非空即按未配置处理。心跳服务（healthchecks.io / uptime-kuma）
// 的鉴权本就在 URL 路径里的随机串，不需要 basic-auth。
//
// env 是模块级单例、每进程固定 ⇒ 又得单开一个文件（同 heartbeat-malformed-url.test.ts 的理由）。
// ============================================================================

const PASSWORD = 'sUp3rS3cr3tPw'
const UUID = 'aaaa-SECRETUUID-bbbb'
const USER = 'hbuser'
let pingHeartbeat: typeof import('../lib/worker.ts').pingHeartbeat
let env: typeof import('../lib/env.ts').env
let tmpDir: string
const warns: string[] = []

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-hb-cred-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  process.env.HEARTBEAT_URL = `https://${USER}:${PASSWORD}@hc-ping.example/${UUID}`
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

// 前置：把本条与上一条区分开——这个值**是合法 URL**，new URL() 拦不住，故必须单独判凭证。
test('前置：该值是合法 URL（new URL 不抛、protocol 也对），上一条的两道判据都放行它', () => {
  const raw = process.env.HEARTBEAT_URL as string
  const u = new URL(raw) // 不抛＝上一条的 try/catch 判据放行
  assert.equal(u.protocol, 'https:', '协议判据也放行它')
  assert.equal(u.password, PASSWORD, '前置：凭证确实在 URL 里')
})

test('复审三轮4：带 basic-auth 凭证的 URL → 配置期就判为空（视为关闭）', () => {
  assert.equal(
    env.worker.heartbeatUrl,
    '',
    '🔴 放行带凭证的 URL 会让它流到 fetch，报错信息里带出明文密码与 uuid 段',
  )
})

test('复审三轮4：配置期告警不回显任何片段（§8 脱敏）', () => {
  const hits = warns.filter((w) => w.includes('HEARTBEAT_URL'))
  assert.equal(hits.length, 1, '应有且仅有一条 HEARTBEAT_URL 告警')
  assert.ok(!hits[0].includes(PASSWORD), '🔴 告警不得回显密码')
  assert.ok(!hits[0].includes(UUID), '🔴 告警不得回显 uuid 段')
  assert.ok(!hits[0].includes(USER), '🔴 用户名也不该回显')
  assert.ok(!hits[0].includes('hc-ping.example'), '🔴 主机名也不该回显（可能是内网标识）')
})

// 🔴 核心：整条链路走一遍，确认**任何输出**都不含密码/uuid。
//    修复前：pingHeartbeat 会真的调 fetch → TypeError 里带整条 URL → console.warn 打出去。
test('复审三轮4：走完整条心跳链路，stdout/stderr 都不含密码与 uuid 段', async () => {
  const logs: string[] = []
  const origWarn = console.warn
  const origErr = console.error
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(' '))
  let fetchCalls = 0
  try {
    // 用**真 fetch**：正是它的 TypeError 带出了凭证。若 heartbeatUrl 已判空则根本走不到这
    const wrapped = ((...args: Parameters<typeof fetch>) => {
      fetchCalls++
      return fetch(...args)
    }) as typeof fetch
    await pingHeartbeat(true, 1_000_000, wrapped)
  } finally {
    console.warn = origWarn
    console.error = origErr
  }
  assert.equal(fetchCalls, 0, '带凭证的 URL 不该走到 fetch')
  const all = logs.join('\n')
  assert.ok(!all.includes(PASSWORD), `🔴 日志泄露了明文密码：${all}`)
  assert.ok(!all.includes(UUID), `🔴 日志泄露了 uuid 段：${all}`)
})

// 补一条边界：只有用户名、没有密码（`https://user@host/<uuid>`）同样会被 fetch 拒绝，也必须拦。
test('复审三轮4：只有用户名没有密码的 URL 同样被 fetch 拒绝 → 也必须在配置期拦下', async () => {
  const raw = `https://${USER}@hc-ping.example/${UUID}`
  const u = new URL(raw)
  assert.equal(u.username, USER)
  assert.equal(u.password, '', '前置：这个变体只有用户名')
  // 实证 fetch 确实会拒绝并把整条 URL 带进错误里（＝为什么 password 为空也要拦）
  let msg = ''
  try {
    await fetch(raw)
  } catch (e) {
    msg = String(e)
  }
  assert.ok(
    msg.includes(UUID),
    `前置：fetch 的报错应带出整条 URL（含 uuid），否则本条的前提不成立。实际：${msg}`,
  )
  // 判据必须是 `username || password`，不能只看 password
  assert.ok(!!(u.username || u.password), '🔴 只判 password 的话这个变体会漏网')
})
