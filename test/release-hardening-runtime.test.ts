import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveWorkerIntervalMs } from '../lib/env.ts'

const root = path.resolve(import.meta.dirname, '..')

test('worker interval：未配置时 MOCK=8s、非 MOCK=5min', () => {
  assert.equal(resolveWorkerIntervalMs(undefined, true), 8_000)
  assert.equal(resolveWorkerIntervalMs('', true), 8_000)
  assert.equal(resolveWorkerIntervalMs(undefined, false), 300_000)
  assert.equal(resolveWorkerIntervalMs('   ', false), 300_000)
})

test('worker interval：非空脏值、非整数、非正、溢出和危险小值 fail-fast', () => {
  for (const raw of ['abc', 'NaN', '1.5', '0', '-1', '+1000', '01', '1000ms', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => resolveWorkerIntervalMs(raw, true), /WORKER_INTERVAL_MS/)
  }
  assert.throws(() => resolveWorkerIntervalMs('999', true), /最小值为 1000ms/)
  assert.throws(() => resolveWorkerIntervalMs('29999', false), /最小值为 30000ms/)
  assert.equal(resolveWorkerIntervalMs('1000', true), 1000)
  assert.equal(resolveWorkerIntervalMs('30000', false), 30000)
})

test('worker interval：不超过 Node 定时器的 32 位有符号上界', () => {
  assert.equal(resolveWorkerIntervalMs('2147483647', true), 2_147_483_647)
  assert.equal(resolveWorkerIntervalMs('2147483647', false), 2_147_483_647)
  for (const raw of ['2147483648', '4294967295', String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => resolveWorkerIntervalMs(raw, true), /WORKER_INTERVAL_MS/)
    assert.throws(() => resolveWorkerIntervalMs(raw, false), /WORKER_INTERVAL_MS/)
  }
})

test('verify-now：路由先做管理员守卫，普通 Dashboard 不再暴露全局验证入口', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/verify-now/route.ts'), 'utf8')
  const contributions = fs.readFileSync(path.join(root, 'components/Contributions.tsx'), 'utf8')
  assert.match(route, /getAdminActor/)
  assert.doesNotMatch(route, /getCurrentUser/)
  assert.ok(route.indexOf('getAdminActor') < route.indexOf("import('@/lib/collect')"), '须先鉴权再加载全局巡检')
  assert.doesNotMatch(contributions, /\/api\/verify-now/)
  assert.doesNotMatch(contributions, /立即验证/)
})

test('发布文档：worker 默认、nginx 最小安全项和 release checklist 同步', () => {
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
  const deploy = fs.readFileSync(path.join(root, 'docs/deploy.md'), 'utf8')
  const checklist = fs.readFileSync(path.join(root, 'docs/release-checklist.md'), 'utf8')

  assert.match(envExample, /非 MOCK 默认 300000/)
  assert.doesNotMatch(envExample, /^WORKER_INTERVAL_MS=8000$/m)

  for (const required of [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'client_max_body_size',
    'client_body_timeout',
    'proxy_connect_timeout',
    'proxy_send_timeout',
    'proxy_read_timeout',
    'Host              hub.example.com',
  ]) {
    assert.ok(deploy.includes(required), `nginx 示例缺少 ${required}`)
  }
  assert.match(deploy, /proxy_read_timeout\s+360s;/, 'nginx read timeout 须覆盖 OAuth finish 的有界最坏时长')
  assert.doesNotMatch(deploy, /proxy_set_header\s+Host\s+\$host/)

  for (const required of [
    'DNS',
    'APP_BASE_URL',
    '0600',
    'dead-man',
    '异机备份',
    'restore',
    'setPriority',
    '真号',
    '50,000',
    '不改 CPAMP',
  ]) {
    assert.ok(checklist.includes(required), `release checklist 缺少 ${required}`)
  }
})
