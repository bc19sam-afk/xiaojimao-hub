import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RedeemItem } from '../lib/db.ts'

// ============================================================================
// P4-R1 审计地基：db.recordAudit / listAudit 往返 + old/new 正确 + 倒序分页 + §8 脱敏铁律
//   （CDK 导入审计只记计数/面额/库存，绝不含码原文）。审计条目构造器（lib/audit.ts）纯函数直测。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指临时目录再**动态 import**；绝不碰真实 data/app.db。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let audit: typeof import('../lib/audit.ts')
let tmpDir: string

const PW_ACTOR = { type: 'password', label: '管理员(密码会话)' }
const LD_ACTOR = { type: 'linuxdo', id: 42, label: 'tester' }

function createItem(o: { name: string; kind?: string; fulfillment?: string }): RedeemItem {
  db.upsertRedeemItem({
    name: o.name,
    description: '',
    cost: 1,
    kind: o.kind ?? 'ldc',
    enabled: true,
    sort: 0,
    fulfillment: o.fulfillment ?? 'cdk',
  })
  const it = db.listRedeemItems(false).find((x) => x.name === o.name)
  if (!it) throw new Error('创建兑换项失败: ' + o.name)
  return it
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-audit-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
  audit = await import('../lib/audit.ts')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ① recordAudit 落全字段 + listAudit 读回；password actor 的 actorId 为 null；old/new 为 JSON 摘要
test('recordAudit/listAudit 往返：actor 字段 + old/new JSON；password actor 无 id', () => {
  db.recordAudit(PW_ACTOR, {
    action: 'ldc_quota.set',
    target: 'ldc_daily_quota',
    old: 2000,
    new: 500,
  })
  const [row] = db.listAudit(1, 0) // 最新一条＝刚写的
  assert.equal(row.actorType, 'password')
  assert.equal(row.actorId, null, 'password 会话 actorId 落 null')
  assert.equal(row.actorLabel, '管理员(密码会话)')
  assert.equal(row.action, 'ldc_quota.set')
  assert.equal(row.target, 'ldc_daily_quota')
  assert.equal(JSON.parse(row.oldValue as string), 2000)
  assert.equal(JSON.parse(row.newValue as string), 500)
  assert.ok(row.createdAt > 0)
})

// ② linuxdo actor 记真实 id；无 old（新建/无旧值）→ old_value 落 null
test('linuxdo actor 记 id；缺省 old/new → 落 null', () => {
  db.recordAudit(LD_ACTOR, { action: 'point_rule.delete', target: 'codex/plus' }) // 无 old/new
  const [row] = db.listAudit(1, 0)
  assert.equal(row.actorType, 'linuxdo')
  assert.equal(row.actorId, 42)
  assert.equal(row.actorLabel, 'tester')
  assert.equal(row.oldValue, null, '未给 old → 落 null')
  assert.equal(row.newValue, null, '未给 new → 落 null')
})

// ③ listAudit 倒序（最新在前）+ 分页（offset 跳过最新）
test('listAudit 倒序 + 分页', () => {
  db.recordAudit(LD_ACTOR, { action: 'test.page', target: 'pa' })
  db.recordAudit(LD_ACTOR, { action: 'test.page', target: 'pb' })
  db.recordAudit(LD_ACTOR, { action: 'test.page', target: 'pc' })
  // 这三条为当前最新三条（同步插入、无并发）
  const top3 = db.listAudit(3, 0)
  assert.deepEqual(top3.map((r) => r.target), ['pc', 'pb', 'pa'], '最新在前')
  const page = db.listAudit(2, 1) // 跳过最新 1 条，取 2 条
  assert.deepEqual(page.map((r) => r.target), ['pb', 'pa'])
})

// ④ §8 脱敏铁律：CDK 导入审计只记「导入 N / 跳过 M（面额 F）+ 库存」计数，**扫描全表绝无码原文**
test('CDK 导入审计不含码原文（§8）：只记计数/面额/库存', () => {
  const item = createItem({ name: 'cdk-audit', kind: 'ldc', fulfillment: 'cdk' })
  const codes = ['ZZ-SECRET-AAAA', 'ZZ-SECRET-BBBB', 'ZZ-SECRET-CCCC']
  const before = db.availableCdkCount(item.id)
  const { imported, skipped } = db.importCdkCodes(item.id, codes, 100)
  const after = db.availableCdkCount(item.id)
  // 与 cdk 路由同款：从「结果计数」构造审计条目（签名不收 codes）
  db.recordAudit(
    LD_ACTOR,
    audit.auditCdkImport({
      itemId: item.id,
      itemName: item.name,
      faceValue: 100,
      imported,
      skipped,
      availableBefore: before,
      availableAfter: after,
    }),
  )
  // 扫描整表：任何码串都不得出现在审计里
  const dump = JSON.stringify(db.listAudit(200, 0))
  for (const c of codes) assert.ok(!dump.includes(c), `审计绝不得含码原文: ${c}`)
  // 计数摘要正确
  const entry = db.listAudit(200, 0).find((r) => r.action === 'cdk.import')
  assert.ok(entry, '应有 cdk.import 审计')
  const nv = JSON.parse(entry!.newValue as string)
  assert.equal(nv.imported, 3)
  assert.equal(nv.skipped, 0)
  assert.equal(nv.faceValue, 100)
  assert.equal(nv.available, after)
  assert.equal(JSON.parse(entry!.oldValue as string).available, before)
})

// ⑤ 条目构造器（纯函数）：point_rule upsert 的 old/new 摘要 + target；ldc_quota old/new
test('audit 构造器：point_rule.upsert old/new 摘要正确', () => {
  const old = { id: 5, provider: 'codex', plan: 'plus', points: 10, enabled: 1, label: '旧' }
  const e = audit.auditPointRuleUpsert(old, {
    provider: 'codex',
    plan: 'plus',
    points: 20,
    enabled: false,
    label: '新',
  })
  assert.equal(e.action, 'point_rule.upsert')
  assert.equal(e.target, 'codex/plus')
  assert.deepEqual(e.old, { provider: 'codex', plan: 'plus', points: 10, enabled: 1, label: '旧' })
  assert.deepEqual(e.new, { provider: 'codex', plan: 'plus', points: 20, enabled: 0, label: '新' })
})

test('audit 构造器：ldc_quota.set old/new 为数值', () => {
  const e = audit.auditLdcQuota(2000, 800)
  assert.equal(e.action, 'ldc_quota.set')
  assert.equal(e.target, 'ldc_daily_quota')
  assert.equal(e.old, 2000)
  assert.equal(e.new, 800)
})

// ⑥ 兑换项删除审计：带 old 摘要（含 name）+ target 带 id
test('audit 构造器：redeem_item.delete 带 old 摘要 + target#id', () => {
  const item = createItem({ name: 'to-delete', kind: 'vip', fulfillment: 'placeholder' })
  const e = audit.auditRedeemItemDelete(item, item.id)
  assert.equal(e.action, 'redeem_item.delete')
  assert.equal(e.target, `item#${item.id}(to-delete)`)
  assert.equal((e.old as { name: string }).name, 'to-delete')
})
