import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ============================================================================
// P4-R1 身份透传：resolveAdminActor 两入口身份 + 白名单 + 优先级（纯决策，不碰 Next 运行时/DB）。
//   ⚠️ 隔离红线：resolveAdminActor 抽在 lib/admin-actor.ts（不 import next/headers、不 import db），
//     故本测试不开任何 DB、不碰真实 data/app.db。env.admin.* 于进程启动读一次 → before 里先设再动态 import。
// ============================================================================

let resolveAdminActor: typeof import('../lib/admin-actor.ts').resolveAdminActor

before(async () => {
  process.env.MOCK = 'true'
  process.env.ADMIN_PASSWORD = 'secret' // 有密码入口
  process.env.ADMIN_LINUXDO_IDS = '123, 456' // 白名单（带空格，env.ts 会 trim）
  ;({ resolveAdminActor } = await import('../lib/admin-actor.ts'))
})

// ① 密码会话入口 → 匿名通用标识（产品已定，勿改文案）
test('密码会话 → { type:password, label:"管理员(密码会话)" }（无 id）', () => {
  const a = resolveAdminActor(true, null)
  assert.deepEqual(a, { type: 'password', label: '管理员(密码会话)' })
  assert.equal(a?.id, undefined, '密码会话不含真实 id')
})

// ② linux.do 白名单管理员 → 真实 id + 用户名
test('linux.do 白名单用户 → { type:linuxdo, id, label:用户名 }', () => {
  const a = resolveAdminActor(false, { id: 123, username: 'alice', trustLevel: 3 })
  assert.deepEqual(a, { type: 'linuxdo', id: 123, label: 'alice' })
  const b = resolveAdminActor(false, { id: 456, username: 'bob', trustLevel: 4 })
  assert.deepEqual(b, { type: 'linuxdo', id: 456, label: 'bob' })
})

// ③ 非白名单 linux.do 用户 → null（不是管理员）
test('非白名单 linux.do 用户 → null', () => {
  assert.equal(resolveAdminActor(false, { id: 999, username: 'eve', trustLevel: 4 }), null)
})

// ④ 无密码会话、无用户 → null
test('无会话无用户 → null', () => {
  assert.equal(resolveAdminActor(false, null), null)
})

// ⑤ 两入口都满足 → 密码优先（与旧 isAdmin 短路顺序一致，不改变哪个入口「胜出」）
test('两入口都满足 → 密码优先', () => {
  const a = resolveAdminActor(true, { id: 123, username: 'alice', trustLevel: 3 })
  assert.equal(a?.type, 'password')
})
