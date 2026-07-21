import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DailyUsage } from '../lib/cpa.ts'

// ============================================================================
// P4-R2 后台配置化三块（§1 / §3.3 / §3.4）：
//   A 折算规则 usage_rates —— CRUD 往返 + 小数单价保真 + ratePerCall 精确→兜底→0
//   B 信任门槛 & 限身份开关 —— isTrustGateEnabled 开关；getMinTrustLevel 缺省回落 env / config 覆盖 / 钳负
//   C 结算参数（结算时刻）—— getSettleGraceMs 缺省 10min / config 覆盖 / 钳 [0,1439] + 注入 now 证 grace 生效
//   D 审计条目构造器（纯函数）—— usage_rate / trust_gate / settle_param 三类 action/target/old/new 正确
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指临时目录再**动态 import**；绝不碰真实 data/app.db。
//   before() 设 MIN_TRUST_LEVEL='2'（先于 import env）：让「缺省回落 env」可与 0 区分。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let audit: typeof import('../lib/audit.ts')
let settle: typeof import('../lib/settle.ts')
let cpa: typeof import('../lib/cpa.ts').cpa
let tmpDir: string

// 桩掉 cpa.getDailyUsage（同一模块单例，settle.ts 看到同一对象）返回指定用量，跑完必还原——仿 daily-settlement
async function withUsage<T>(usage: DailyUsage[], fn: () => Promise<T>): Promise<T> {
  const orig = cpa.getDailyUsage
  cpa.getDailyUsage = async () => usage
  try {
    return await fn()
  } finally {
    cpa.getDailyUsage = orig
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-cfg-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  process.env.MIN_TRUST_LEVEL = '2' // 先于 import env：env.linuxdo.minTrustLevel=2，供「缺省回落 env」测试
  ;({ db } = await import('../lib/db.ts'))
  audit = await import('../lib/audit.ts')
  settle = await import('../lib/settle.ts')
  ;({ cpa } = await import('../lib/cpa.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------- A：折算规则 usage_rates ----------------------------

// A1 CRUD 往返 + provider/plan 小写规整（仿 point_rules，键＝(provider,plan)）
test('A1 usage_rates CRUD 往返 + provider/plan 小写规整', () => {
  db.upsertUsageRate({ provider: 'TestP', plan: 'Plus', pointsPerCall: 2, enabled: true, label: '测试' })
  let row = db.listUsageRates().find((r) => r.provider === 'testp' && r.plan === 'plus')
  assert.ok(row, '应插入并小写规整')
  assert.equal(row!.pointsPerCall, 2)
  assert.equal(row!.enabled, 1)
  assert.equal(row!.label, '测试')
  // upsert 同 (provider,plan) → 更新不新增
  const before = db.listUsageRates().length
  db.upsertUsageRate({ provider: 'testp', plan: 'plus', pointsPerCall: 5, enabled: false, label: '改' })
  assert.equal(db.listUsageRates().length, before, 'upsert 命中唯一键不新增')
  row = db.listUsageRates().find((r) => r.provider === 'testp' && r.plan === 'plus')
  assert.equal(row!.pointsPerCall, 5)
  assert.equal(row!.enabled, 0)
  assert.equal(row!.label, '改')
  // 删除
  const id = row!.id
  db.deleteUsageRate(id)
  assert.equal(db.listUsageRates().find((r) => r.id === id), undefined, '删后不在')
})

// A2 小数单价保真：0.1 存取一致（points_per_call REAL 列不截断）
test('A2 usage_rates 小数单价保真：0.1 存取一致', () => {
  db.upsertUsageRate({ provider: 'decp', plan: '*', pointsPerCall: 0.1, enabled: true, label: '小数' })
  const row = db.listUsageRates().find((r) => r.provider === 'decp' && r.plan === '*')
  assert.equal(row!.pointsPerCall, 0.1) // 小数不被截断
  assert.equal(db.ratePerCall('decp', 'anything'), 0.1) // 兜底命中、单价保真
})

// A3 ratePerCall：精确 > provider 兜底(*) > 无规则=0；大小写不敏感；enabled=0 精确被跳过回落兜底
test('A3 ratePerCall：精确 > 兜底 > 0；大小写不敏感；禁用精确回落兜底', () => {
  db.upsertUsageRate({ provider: 'ratep', plan: 'plus', pointsPerCall: 3, enabled: true, label: '' })
  db.upsertUsageRate({ provider: 'ratep', plan: '*', pointsPerCall: 1, enabled: true, label: '' })
  assert.equal(db.ratePerCall('ratep', 'plus'), 3) // 精确
  assert.equal(db.ratePerCall('ratep', 'team'), 1) // 兜底 *
  assert.equal(db.ratePerCall('RATEP', 'PLUS'), 3) // 大小写不敏感（仿 pointsFor）
  assert.equal(db.ratePerCall('nobody', 'x'), 0) // 无任何规则=0
  db.upsertUsageRate({ provider: 'ratep', plan: 'off', pointsPerCall: 9, enabled: false, label: '' })
  assert.equal(db.ratePerCall('ratep', 'off'), 1) // 精确禁用 → 兜底 *
})

// A4 listUsageRates 列别名（points_per_call → pointsPerCall）+ 种子存在（seedDefaults 播的档）
test('A4 listUsageRates 字段别名 pointsPerCall + 种子档存在', () => {
  const rows = db.listUsageRates()
  assert.ok(rows.length > 0, '应有种子档')
  for (const r of rows) {
    assert.ok('pointsPerCall' in r, '字段应别名为 pointsPerCall（非 points_per_call）')
    assert.equal(typeof r.pointsPerCall, 'number')
  }
  // seedDefaults 播的 codex/plus 存在
  assert.ok(rows.find((r) => r.provider === 'codex' && r.plan === 'plus'), '种子 codex/plus 应在')
})

// ---------------------------- B：信任门槛 & 限身份开关 ----------------------------

// B1 getMinTrustLevel 缺省回落 env(2) / config 覆盖优先 / setMinTrustLevel 钳负值（本测试须先于其它 min_trust 改动）
test('B1 getMinTrustLevel：缺省回落 env / config 覆盖 / 钳负值', () => {
  assert.equal(db.getMinTrustLevel(), 2, '无 config 键 → 回落 env.linuxdo.minTrustLevel(=2)')
  db.setMinTrustLevel(5)
  assert.equal(db.getMinTrustLevel(), 5, 'config 覆盖 env')
  db.setMinTrustLevel(-3)
  assert.equal(db.getMinTrustLevel(), 0, '负值钳 0')
})

// B2 isTrustGateEnabled 缺省 true；setTrustGateEnabled 开关（本测试须先于其它 trust_gate 改动）
test('B2 isTrustGateEnabled：缺省 true；开关切换', () => {
  assert.equal(db.isTrustGateEnabled(), true, '缺省启用门槛')
  db.setTrustGateEnabled(false)
  assert.equal(db.isTrustGateEnabled(), false, '关闭＝登录即可、不限等级')
  db.setTrustGateEnabled(true)
  assert.equal(db.isTrustGateEnabled(), true)
})

// B3 getMinTrustLevel 脏 config 值 → 回落 env（即便有人绕 setter 直写脏值，判定仍安全）
test('B3 getMinTrustLevel：脏 config 值回落 env', () => {
  db.setConfig('min_trust_level', 'abc') // 绕过 setter 直写脏值
  assert.equal(db.getMinTrustLevel(), 2, '脏值 → 回落 env(2)')
})

// ---------------------------- C：结算参数（结算时刻）----------------------------

// C1 getSettleGraceMs 缺省 10min / config 覆盖 / 钳 [0,1439]（本测试须先于其它 settle_grace 改动）
test('C1 getSettleGraceMs：缺省 10min / config 覆盖 / 钳 [0,1439]', () => {
  assert.equal(db.getSettleGraceMs(), 10 * 60_000, '缺省 10 分钟')
  db.setSettleGraceMinutes(20)
  assert.equal(db.getSettleGraceMs(), 20 * 60_000, 'config 覆盖')
  db.setSettleGraceMinutes(5000) // 上钳 1439
  assert.equal(db.getSettleGraceMs(), 1439 * 60_000, '上钳 1439')
  db.setSettleGraceMinutes(-3) // 下钳 0
  assert.equal(db.getSettleGraceMs(), 0, '下钳 0')
})

// C2 配置的 grace 生效（注入 now，仿 daily-settlement）：grace 内跳过、grace 外结算
test('C2 结算 grace 生效：grace 内跳过、grace 外结算（注入 now）', async () => {
  db.setSettleGraceMinutes(30) // 结算时刻＝午夜后 30 分钟
  const at = (min: number) => new Date(2027, 0, 15, 0, min).getTime() // 固定日 + force 绕节流
  // grace 内（00:20 < 30min）→ skipped（force 不绕 grace）
  const rIn = await withUsage([], () => settle.settleDailyUsage(at(20), { force: true }))
  assert.equal(rIn.skipped, true, 'grace 内应跳过')
  // grace 外（00:40 ≥ 30min）→ 真正跑（空 usage、settled=0 但不 skipped）
  const rOut = await withUsage([], () => settle.settleDailyUsage(at(40), { force: true }))
  assert.ok(!rOut.skipped, 'grace 外应结算')
})

// C3 getSettleGraceMs 脏 config 值 → 回落 10min
test('C3 getSettleGraceMs：脏 config 值回落 10min', () => {
  db.setConfig('settle_grace_minutes', 'xyz') // 绕过 setter 直写脏值
  assert.equal(db.getSettleGraceMs(), 10 * 60_000, '脏值 → 回落 10min')
})

// ---------------------------- D：审计条目构造器（纯函数）----------------------------

// D1 usage_rate upsert/delete：old/new 摘要（含 pointsPerCall）+ target=provider/plan + enabled 规整 1/0
test('D1 audit：usage_rate upsert/delete old/new 摘要 + target', () => {
  const old = { id: 3, provider: 'codex', plan: 'plus', pointsPerCall: 0.5, enabled: 1, label: '旧' }
  const e = audit.auditUsageRateUpsert(old, { provider: 'codex', plan: 'plus', pointsPerCall: 0.8, enabled: false, label: '新' })
  assert.equal(e.action, 'usage_rate.upsert')
  assert.equal(e.target, 'codex/plus')
  assert.deepEqual(e.old, { provider: 'codex', plan: 'plus', pointsPerCall: 0.5, enabled: 1, label: '旧' })
  assert.deepEqual(e.new, { provider: 'codex', plan: 'plus', pointsPerCall: 0.8, enabled: 0, label: '新' })
  const del = audit.auditUsageRateDelete(old, 3)
  assert.equal(del.action, 'usage_rate.delete')
  assert.equal(del.target, 'codex/plus')
  assert.equal((del.old as { pointsPerCall: number }).pointsPerCall, 0.5)
  // 无旧值删除 → target 回落 #id、old 省略
  const del2 = audit.auditUsageRateDelete(undefined, 7)
  assert.equal(del2.target, '#7')
  assert.equal(del2.old, undefined)
})

// D2 trust_gate.set：old/new（enabled 规整 1/0）+ target=trust_gate
test('D2 audit：trust_gate.set old/new（enabled 规整 1/0）', () => {
  const e = audit.auditTrustGate({ enabled: true, minTrust: 1 }, { enabled: false, minTrust: 3 })
  assert.equal(e.action, 'trust_gate.set')
  assert.equal(e.target, 'trust_gate')
  assert.deepEqual(e.old, { enabled: 1, minTrust: 1 })
  assert.deepEqual(e.new, { enabled: 0, minTrust: 3 })
})

// D3 settle_param.set：old/new 为分钟数 + target=settle_grace_minutes
test('D3 audit：settle_param.set old/new 为分钟数', () => {
  const e = audit.auditSettleParam(10, 30)
  assert.equal(e.action, 'settle_param.set')
  assert.equal(e.target, 'settle_grace_minutes')
  assert.equal(e.old, 10)
  assert.equal(e.new, 30)
})

// D4 端到端：recordAudit 落 trust_gate 条目 → listAudit 读回（脱敏摘要持久化路径）
test('D4 audit 端到端：trust_gate 条目 recordAudit → listAudit 读回', () => {
  const actor = { type: 'linuxdo', id: 9, label: 'admin9' }
  db.recordAudit(actor, audit.auditTrustGate({ enabled: true, minTrust: 0 }, { enabled: true, minTrust: 2 }))
  const row = db.listAudit(50, 0).find((r) => r.action === 'trust_gate.set')
  assert.ok(row, '应有 trust_gate.set 留痕')
  assert.equal(row!.target, 'trust_gate')
  assert.deepEqual(JSON.parse(row!.newValue as string), { enabled: 1, minTrust: 2 })
})
