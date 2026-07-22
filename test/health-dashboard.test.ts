import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, migrations, LATEST_VERSION } from '../lib/migrate.ts'
import type { Contribution } from '../lib/db.ts'
import type { AuthFile, DailyUsage, ProbeResult } from '../lib/cpa.ts'

// ⚠️ db.ts 模块级会 openDb()——绝不在顶部 **值导入** 它，否则在 before() 设 DB_PATH 前就打开真实
// data/app.db（globalThis.__appDb 缓存后 before() 的动态 import 也复用它）→ 破坏隔离红线。
// describeLedgerEntry/shortAccountLabel 虽是纯函数，也一律走 before() 的动态 import 取得。

// ============================================================================
// P2-R3（P2 收官，非破坏：加表+加逻辑）。四块：
//   Part A —— migration 009 结构：v8 库跑迁移后 rejections 表在、版本到最新。直接驱动 migrate/up、内存库。
//   Part B —— 号存活巡检 checkPooledHealth（走 lib/collect.ts，MOCK、单例连接）：codex inspect
//             reject→stopped / retry(限额)→保持 / reauth→needs_review / ok/未覆盖/inspect 抛错→保持；
//             claude·grok 文件不存在→stopped / 存在→保持 / listAuthFiles 抛错→保持；只碰 pooled 不碰首检态。
//   Part C —— 每号累计积分 contributionPoints（多日结算求和）+ 首检退回记录（recordRejection/rejectionsFor
//             + processPending reject 端到端：删行释放唯一键 + 记退回，R1 行为不变）。
//   Part D —— 积分明细文案 describeLedgerEntry / shortAccountLabel（usage 解析日期、账号掩码、不泄敏感）
//             + ledgerFor 往返 + stopped 后只结历史日（R2 不变）。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指向临时目录再动态 import；绝不碰真实 data/。
//   ⚠️ 巡检测试全用桩（inspect + listAuthFiles）确定性覆盖，且**只断言各自目标号**——巡检会顺带处理
//      其它历史遗留 pooled 号（翻不翻不影响本测目标），故跨测无污染。
// ============================================================================

// ---------------------------- Part A：migration 009（内存库）----------------------------

function makeDbAt(target: number): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const m of migrations.filter((m) => m.version <= target).sort((a, b) => a.version - b.version)) {
    m.up(d)
  }
  d.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(target)
  return d
}
function tableNames(d: DatabaseSync): Set<string> {
  const rows = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

test('迁移009：建 rejections 表、版本到最新、列可写回', () => {
  assert.ok(migrations.some((m) => m.version === 9), '应存在 migration 009')
  const d = makeDbAt(8) // stamped v8 → migrate 只跑 009
  const v = migrate(d)
  assert.equal(v, LATEST_VERSION)
  assert.ok(tableNames(d).has('rejections'), '缺表 rejections')
  // 列齐、可插入读回
  d.prepare(
    'INSERT INTO rejections (linuxdo_id, provider, account_id, reason, created_at) VALUES (?,?,?,?,?)',
  ).run(42, 'codex', 'acc-x', '登录失败或已被封号，未入池', 1000)
  const row = d.prepare('SELECT linuxdo_id, provider, account_id, reason FROM rejections WHERE linuxdo_id=42').get() as {
    linuxdo_id: number
    provider: string
    account_id: string
    reason: string
  }
  assert.equal(row.provider, 'codex')
  assert.equal(row.account_id, 'acc-x')
  assert.match(row.reason, /登录失败/)
  d.close()
})

// ---------------------------- Part B/C/D：单例连接 / MOCK ----------------------------

let db: typeof import('../lib/db.ts').db
let describeLedgerEntry: typeof import('../lib/db.ts').describeLedgerEntry
let shortAccountLabel: typeof import('../lib/db.ts').shortAccountLabel
let collect: typeof import('../lib/collect.ts')
let settle: typeof import('../lib/settle.ts')
let cpa: typeof import('../lib/cpa.ts').cpa
let tmpDir: string

function makeContribution(over: Partial<Contribution>): Contribution {
  const now = Date.now()
  return {
    id: 'id-' + Math.random().toString(16).slice(2),
    linuxdoId: 1,
    username: 'u',
    accountId: 'acc',
    email: 'e@example.com',
    provider: 'codex',
    plan: 'plus',
    method: 'oauth',
    authFileName: 'f.json',
    verifyStatus: 'pooled',
    points: 0,
    rewardStatus: 'none',
    rewardText: '',
    rewardNote: '',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

// 桩掉 cpa.inspect + cpa.listAuthFiles（同一模块单例，collect.ts 看到同一对象），跑完必还原。
// 两者可分别指定返回或抛错，确定性覆盖 checkPooledHealth 的全部分支。
async function withCpa<T>(
  over: { probes?: ProbeResult[]; probesThrow?: boolean; files?: AuthFile[]; filesThrow?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  const oi = cpa.inspect
  const ol = cpa.listAuthFiles
  cpa.inspect = async () => {
    if (over.probesThrow) throw new Error('inspect down')
    return over.probes ?? []
  }
  cpa.listAuthFiles = async () => {
    if (over.filesThrow) throw new Error('listAuthFiles down')
    return over.files ?? []
  }
  try {
    return await fn()
  } finally {
    cpa.inspect = oi
    cpa.listAuthFiles = ol
  }
}
async function withUsage<T>(usage: DailyUsage[], fn: () => Promise<T>): Promise<T> {
  const orig = cpa.getDailyUsage
  cpa.getDailyUsage = async () => usage
  try {
    return await fn()
  } finally {
    cpa.getDailyUsage = orig
  }
}
const authFile = (provider: string, accountId: string): AuthFile => ({
  name: `${provider}-${accountId}.json`,
  accountId,
  email: '',
  plan: 'x',
  disabled: false,
  provider: provider as AuthFile['provider'],
})
const statusOf = (id: string): string | undefined => db.all().find((c) => c.id === id)?.verifyStatus

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-r3-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  const dbMod = await import('../lib/db.ts') // 动态 import：此刻 DB_PATH 已指向 tmp
  db = dbMod.db
  describeLedgerEntry = dbMod.describeLedgerEntry
  shortAccountLabel = dbMod.shortAccountLabel
  collect = await import('../lib/collect.ts')
  settle = await import('../lib/settle.ts')
  ;({ cpa } = await import('../lib/cpa.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// —— 首检退回端到端（放最前：消费掉自己的号，不留 submitted 干扰后续 processPending）——
// codex 首检 reject → rejectBack：删行释放唯一键（R1 不变）+ recordRejection 留一条退回（R3 新增）
test('首检 reject 端到端：删行释放唯一键 + rejections 记一条（R1 行为不变）', async () => {
  const uid = 8100
  const id = 'e2e-reject'
  const accountId = 'e2e-reject-acc'
  db.insertUnique(
    makeContribution({ id, provider: 'codex', accountId, authFileName: `codex-${accountId}.json`, plan: 'plus', linuxdoId: uid, verifyStatus: 'submitted' }),
  )
  await withCpa({ probes: [{ accountId, decision: 'reject', plan: 'plus', reason: 'unauthorized' }] }, () =>
    collect.processPending(),
  )
  // 行被删（首检失败不占唯一键，R1 不变）
  assert.equal(db.byUser(uid).find((x) => x.id === id), undefined)
  // 唯一键释放：可重插（用户修好重交）
  assert.equal(
    db.insertUnique(makeContribution({ id: 'e2e-reject-again', provider: 'codex', accountId, linuxdoId: uid, verifyStatus: 'submitted' })).duplicate,
    false,
  )
  // R3 新增：留了一条退回记录（中性人话，不透传 CPA 原文）
  const rej = db.rejectionsFor(uid)
  assert.equal(rej.length, 1)
  assert.equal(rej[0].provider, 'codex')
  assert.equal(rej[0].accountId, accountId)
  assert.match(rej[0].reason, /登录失败|封号/)
  assert.doesNotMatch(rej[0].reason, /unauthorized/) // 绝不透传 CPA 原文
})

// —— Part B：号存活巡检 checkPooledHealth ——

test('巡检 codex reject（401/撤权/删除＝明确失效）→ pooled→stopped', async () => {
  const id = 'h-codex-reject'
  const accountId = 'h-codex-reject-acc'
  db.insertUnique(makeContribution({ id, provider: 'codex', accountId, linuxdoId: 8201 }))
  await withCpa({ probes: [{ accountId, decision: 'reject', plan: 'plus', reason: 'unauthorized' }] }, () =>
    collect.checkPooledHealth(undefined, { force: true }),
  )
  assert.equal(statusOf(id), 'stopped')
})

test('巡检 codex retry（限额不算失败，§3.2）→ 保持 pooled', async () => {
  const id = 'h-codex-retry'
  const accountId = 'h-codex-retry-acc'
  db.insertUnique(makeContribution({ id, provider: 'codex', accountId, linuxdoId: 8202 }))
  await withCpa({ probes: [{ accountId, decision: 'retry', plan: 'plus', reason: 'usage_limit' }] }, () =>
    collect.checkPooledHealth(undefined, { force: true }),
  )
  assert.equal(statusOf(id), 'pooled')
})

test('巡检 codex reauth（需重授权）→ needs_review', async () => {
  const id = 'h-codex-reauth'
  const accountId = 'h-codex-reauth-acc'
  db.insertUnique(makeContribution({ id, provider: 'codex', accountId, linuxdoId: 8203 }))
  await withCpa({ probes: [{ accountId, decision: 'reauth', plan: 'plus', reason: 'relogin' }] }, () =>
    collect.checkPooledHealth(undefined, { force: true }),
  )
  assert.equal(statusOf(id), 'needs_review')
})

test('巡检 codex ok → 保持 pooled', async () => {
  const id = 'h-codex-ok'
  const accountId = 'h-codex-ok-acc'
  db.insertUnique(makeContribution({ id, provider: 'codex', accountId, linuxdoId: 8204 }))
  await withCpa({ probes: [{ accountId, decision: 'ok', plan: 'plus', reason: 'ok' }] }, () =>
    collect.checkPooledHealth(undefined, { force: true }),
  )
  assert.equal(statusOf(id), 'pooled')
})

test('巡检 codex 未被 inspect 覆盖 → 保持 pooled（不误判死）', async () => {
  const id = 'h-codex-uncovered'
  db.insertUnique(makeContribution({ id, provider: 'codex', accountId: 'h-codex-uncovered-acc', linuxdoId: 8205 }))
  // probes 里没有本号 → 跳过
  await withCpa({ probes: [{ accountId: 'someone-else', decision: 'reject', plan: 'plus', reason: 'x' }] }, () =>
    collect.checkPooledHealth(undefined, { force: true }),
  )
  assert.equal(statusOf(id), 'pooled')
})

test('巡检 inspect 整体抛错 → codex 号本轮全跳过、保持 pooled', async () => {
  const id = 'h-codex-inspectthrow'
  db.insertUnique(makeContribution({ id, provider: 'codex', accountId: 'h-codex-inspectthrow-acc', linuxdoId: 8206 }))
  await withCpa({ probesThrow: true }, () => collect.checkPooledHealth(undefined, { force: true }))
  assert.equal(statusOf(id), 'pooled')
})

test('巡检 grok 文件仍在（含 disabled）→ 保持 pooled', async () => {
  const id = 'h-grok-present'
  const accountId = 'h-grok-present-acc'
  db.insertUnique(makeContribution({ id, provider: 'grok', accountId, plan: 'super', linuxdoId: 8207 }))
  const f = authFile('grok', accountId)
  await withCpa({ files: [{ ...f, disabled: true }] }, () => collect.checkPooledHealth(undefined, { force: true }))
  assert.equal(statusOf(id), 'pooled') // disabled 也算在（管理员手动禁用/限额不算失败）
})

test('巡检 grok 文件不存在（被删/撤销）→ pooled→stopped', async () => {
  const id = 'h-grok-gone'
  db.insertUnique(makeContribution({ id, provider: 'grok', accountId: 'h-grok-gone-acc', plan: 'super', linuxdoId: 8208 }))
  await withCpa({ files: [authFile('grok', 'h-grok-decoy-acc')] }, () => collect.checkPooledHealth(undefined, { force: true })) // 非空清单但不含本号（空清单会被 glitch 保护跳过）
  assert.equal(statusOf(id), 'stopped')
})

test('巡检 claude 文件在 / 不在：分别保持 pooled / stopped', async () => {
  const keep = 'h-claude-keep'
  const gone = 'h-claude-gone'
  db.insertUnique(makeContribution({ id: keep, provider: 'claude', accountId: 'h-claude-keep-acc', plan: 'pro', linuxdoId: 8209 }))
  db.insertUnique(makeContribution({ id: gone, provider: 'claude', accountId: 'h-claude-gone-acc', plan: 'pro', linuxdoId: 8210 }))
  // 清单只含 keep 的号 → keep 保持、gone 停用
  await withCpa({ files: [authFile('claude', 'h-claude-keep-acc')] }, () => collect.checkPooledHealth(undefined, { force: true }))
  assert.equal(statusOf(keep), 'pooled')
  assert.equal(statusOf(gone), 'stopped')
})

test('巡检 listAuthFiles 抛错 → claude/grok 本轮全跳过、保持 pooled', async () => {
  const id = 'h-grok-listthrow'
  db.insertUnique(makeContribution({ id, provider: 'grok', accountId: 'h-grok-listthrow-acc', plan: 'super', linuxdoId: 8211 }))
  await withCpa({ filesThrow: true }, () => collect.checkPooledHealth(undefined, { force: true }))
  assert.equal(statusOf(id), 'pooled')
})

test('巡检只碰 pooled：首检态（first_check）不受影响', async () => {
  const id = 'h-firstcheck-untouched'
  db.insertUnique(
    makeContribution({ id, provider: 'grok', accountId: 'h-fc-acc', plan: 'super', linuxdoId: 8212, verifyStatus: 'first_check' }),
  )
  await withCpa({ files: [authFile('grok', 'h-decoy2-acc')] }, () => collect.checkPooledHealth(undefined, { force: true })) // 非空清单
  assert.equal(statusOf(id), 'first_check') // 巡检不拉首检态，岿然不动
})

// —— Part C：每号累计积分 + 退回记录往返 ——

test('contributionPoints：多日结算求和；他号不计入；无结算=0', () => {
  const cid = 'cp-sum'
  const other = 'cp-other'
  for (const [date, pts] of [['2026-06-01', 5], ['2026-06-02', 7], ['2026-06-03', 9]] as const) {
    db.recordSettlement({ contributionId: cid, date, provider: 'grok', accountId: 'cp-acc', callCount: pts, points: pts })
  }
  db.recordSettlement({ contributionId: other, date: '2026-06-01', provider: 'grok', accountId: 'cp-other-acc', callCount: 100, points: 100 })
  assert.equal(db.contributionPoints(cid), 21) // 5+7+9，只含本号
  assert.equal(db.contributionPoints(other), 100)
  assert.equal(db.contributionPoints('cp-nonexistent'), 0)
})

test('recordRejection / rejectionsFor 往返：按时间倒序、掩码前存原始号', () => {
  const uid = 8300
  db.recordRejection({ linuxdoId: uid, provider: 'codex', accountId: 'r-acc-1', reason: '登录失败或已被封号，未入池' })
  db.recordRejection({ linuxdoId: uid, provider: 'claude', accountId: 'r-acc-2', reason: '登录失败或已被封号，未入池' })
  const list = db.rejectionsFor(uid)
  assert.equal(list.length, 2)
  assert.equal(list[0].accountId, 'r-acc-2') // 最近在前
  assert.equal(list[1].accountId, 'r-acc-1')
  assert.equal(db.rejectionsFor(999999).length, 0) // 他人无
})

// —— Part D：积分明细文案 + ledgerFor + stopped 只结历史 ——

test('shortAccountLabel：provider 中文 + 尾4位，不泄完整敏感号', () => {
  assert.equal(shortAccountLabel('codex', 'acct_secret_1234'), 'ChatGPT·1234')
  assert.equal(shortAccountLabel('claude', 'acct_pqrs'), 'Claude·pqrs') // 恰 4 位
  assert.equal(shortAccountLabel('grok', 'ab'), 'Grok·ab') // 不足 4 位原样
  assert.equal(shortAccountLabel('codex', ''), 'ChatGPT') // 空号仅 provider
  // 绝不含完整敏感段
  assert.doesNotMatch(shortAccountLabel('codex', 'acct_secret_1234'), /secret/)
  // claude 的 accountId 本身是邮箱（对接-R1 §二③）：掩码后不得含完整邮箱——settle 日志据此按 §8 脱敏
  assert.doesNotMatch(shortAccountLabel('claude', 'foo@bar.com'), /foo@bar\.com/)
})

test('describeLedgerEntry：usage 解析日期+账号短标识；其它 reason 稳定中文；不泄敏感', () => {
  const accountOf = (cid: string) =>
    cid === 'cid-1' ? { provider: 'codex', accountId: 'acct_secret_9876' } : undefined
  // usage：解析出 7 月 19 日 + 账号短标识
  const usageText = describeLedgerEntry({ reason: 'usage', ref: 'usage:cid-1:2026-07-19' }, accountOf)
  assert.equal(usageText, '〔ChatGPT·9876〕7 月 19 日 用量结算')
  assert.doesNotMatch(usageText, /secret|acct_secret/) // 不泄完整号
  // usage 但 cid 解析不到账号 → 回落「账号」，仍出日期
  assert.equal(
    describeLedgerEntry({ reason: 'usage', ref: 'usage:unknown:2026-01-05' }, accountOf),
    '〔账号〕1 月 5 日 用量结算',
  )
  // ref 结构异常的 usage → 兜底「用量结算」，不抛
  assert.equal(describeLedgerEntry({ reason: 'usage', ref: 'garbage' }, accountOf), '用量结算')
  // 其它 reason 保持稳定中文
  assert.equal(describeLedgerEntry({ reason: 'redeem', ref: 'x' }, accountOf), '积分兑换')
  assert.equal(describeLedgerEntry({ reason: 'contribution', ref: 'x' }, accountOf), '贡献奖励')
  assert.equal(describeLedgerEntry({ reason: 'weird', ref: 'x' }, accountOf), '积分变动')
})

test('ledgerFor：按时间倒序取本人流水，喂给 describeLedgerEntry 出人话', () => {
  const uid = 8400
  const cid = 'led-cid'
  db.awardPoints(uid, 12, 'usage', `usage:${cid}:2026-07-19`)
  db.awardPoints(uid, 5, 'usage', `usage:${cid}:2026-07-20`)
  const rows = db.ledgerFor(uid)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].ref, `usage:${cid}:2026-07-20`) // 最近在前
  const accountOf = (c: string) => (c === cid ? { provider: 'grok', accountId: 'acct_zzzz9999' } : undefined)
  assert.equal(describeLedgerEntry(rows[0], accountOf), '〔Grok·9999〕7 月 20 日 用量结算')
})

test('stopped 后只结历史日：巡检停用→历史日照结（R2 欠薪不变）、今天不结', async () => {
  const uid = 8500
  const id = 'stop-settle'
  const accountId = 'stop-settle-acc'
  db.insertUnique(makeContribution({ id, provider: 'grok', accountId, plan: 'super', linuxdoId: uid })) // grok/*=1
  db.update(id, { pooledAt: new Date(2026, 6, 10).getTime() }) // 早就入池（早于下面 7-19 用量），结算资格
  // 巡检判失效 → stopped（非空清单但不含本号；空清单会被 glitch 保护跳过）
  await withCpa({ files: [authFile('grok', 'stop-decoy-acc')] }, () => collect.checkPooledHealth(undefined, { force: true }))
  assert.equal(statusOf(id), 'stopped')
  const balBefore = db.balance(uid)
  const now = new Date(2026, 6, 20, 12).getTime() // today = 2026-07-20
  // 昨天有用量 → 停用后仍补结历史日（§3.5 欠薪不赖账）
  await withUsage([{ accountId, provider: 'grok', date: '2026-07-19', count: 8 }], () =>
    settle.settleDailyUsage(now, { force: true }),
  )
  assert.equal(db.settlementsFor(id).length, 1, 'stopped 号历史日应补结')
  assert.equal(db.balance(uid), balBefore + 8) // grok/*=1 → 8×1
  // 今天（进行中）→ 不结（§3.3 只结已过完自然日）；不产生新结算
  await withUsage([{ accountId, provider: 'grok', date: '2026-07-20', count: 5 }], () =>
    settle.settleDailyUsage(now, { force: true }),
  )
  assert.equal(db.settlementsFor(id).length, 1, '今天不结，settlement 仍只 1 笔')
})

// —— codex xhigh 于 PR #18 的补充修复 ——

// 空清单保护：listAuthFiles 返回 []（cpamp glitch）→ 绝不把 pooled claude/grok 判失效（防误停整池）
test('空清单保护：listAuthFiles 空 → pooled claude/grok 保持（不误停整池）', async () => {
  const id = 'h-empty-guard'
  db.insertUnique(makeContribution({ id, provider: 'grok', accountId: 'h-empty-acc', plan: 'super', linuxdoId: 8250 }))
  await withCpa({ files: [] }, () => collect.checkPooledHealth(undefined, { force: true }))
  assert.equal(statusOf(id), 'pooled') // 空清单视为不可观测、跳过，绝不停用
})

// 存活巡检节流：默认（非 force）同窗口内第二次调用 skip，不重复全量 inspect（防 8s tick 满负荷）
test('存活巡检节流：5 分钟窗口内第二次 checkPooledHealth 跳过', async () => {
  const base = new Date(2027, 0, 1, 12).getTime() // 远离其它测试设的 lastHealthAt
  const r1 = await withCpa({ probes: [] }, () => collect.checkPooledHealth(base)) // 距上次 >5min → 跑
  assert.ok(!r1.skipped)
  const r2 = await withCpa({ probes: [] }, () => collect.checkPooledHealth(base + 60_000)) // <5min → skip
  assert.equal(r2.skipped, true)
  const r3 = await withCpa({ probes: [] }, () => collect.checkPooledHealth(base + 6 * 60_000)) // >5min → 再跑
  assert.ok(!r3.skipped)
})

// 清退回往返：recordRejection 记 → rejectionsFor 可读 → clearRejections（重交成功时调）清除
test('清退回往返：recordRejection → rejectionsFor → clearRejections 清除', () => {
  db.recordRejection({ linuxdoId: 8270, provider: 'codex', accountId: 'rc-acc', reason: '登录失败或已被封号，未入池' })
  assert.equal(db.rejectionsFor(8270).length, 1)
  db.clearRejections(8270, 'codex', 'rc-acc') // recordIngest 重交成功时调用同款（限本人 linuxdo_id）
  assert.equal(db.rejectionsFor(8270).length, 0)
})
