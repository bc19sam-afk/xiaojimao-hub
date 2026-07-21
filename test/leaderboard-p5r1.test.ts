import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Contribution } from '../lib/db.ts'

// ============================================================================
// P5-R1 排行榜口径：入池号数 → 累计获得积分（§6）
//   排名依据 = SUM(正 delta)（发分为正 awardPoints / 兑换扣减为负 spendPoints）。
//   花费的负 delta 不进「获得」求和 ⇒ 花掉不掉名次。points（非号数、非余额）。
//   L1 按累计获得降序 / L2 花掉不掉名次（核心）/ L3 上榜条件 / L4 username 子查询 / L5 同分 tie-break。
//   ⚠️ 隔离红线：DB_PATH / MOCK_CPA_PATH 指临时目录再**动态 import** lib/db.ts；绝不碰真实 data/app.db。
// ============================================================================

let db: typeof import('../lib/db.ts').db
let tmpDir: string

// 造一个带 username 的贡献号（L4 username 子查询兜底用）；point_ledger 只有 linuxdo_id，username 需从贡献表取
function seedContribution(linuxdoId: number, username: string, accountId: string): void {
  const now = Date.now()
  const c: Contribution = {
    id: 'lb-' + accountId,
    linuxdoId, username, accountId, email: 'e@example.com',
    provider: 'codex', plan: 'plus', method: 'oauth', authFileName: 'f.json',
    verifyStatus: 'pooled', points: 0, rewardStatus: 'none', rewardText: '', rewardNote: '',
    createdAt: now, updatedAt: now,
  }
  db.insertUnique(c)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-lb-'))
  process.env.MOCK = 'true'
  process.env.DB_PATH = path.join(tmpDir, 'app.db')
  process.env.MOCK_CPA_PATH = path.join(tmpDir, 'mock-cpa.json')
  ;({ db } = await import('../lib/db.ts'))
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// L1 按累计获得积分降序（各断言只看本测试自己的 uid，隔离共享 DB 中其它测试的数据）
test('L1 leaderboard 按累计获得积分降序', () => {
  db.awardPoints(5101, 30, 'usage', 'l1-a')
  db.awardPoints(5102, 70, 'usage', 'l1-b')
  db.awardPoints(5103, 50, 'usage', 'l1-c')
  const uids = [5101, 5102, 5103]
  const list = db.leaderboard(100)
  const ordered = list.filter((e) => uids.includes(e.linuxdoId)).map((e) => e.linuxdoId)
  assert.deepEqual(ordered, [5102, 5103, 5101], '按累计获得降序 70>50>30')
  const byId = new Map(list.map((e) => [e.linuxdoId, e.points]))
  assert.equal(byId.get(5102), 70)
  assert.equal(byId.get(5103), 50)
  assert.equal(byId.get(5101), 30)
})

// L2 🔴 花掉不掉名次（核心语义）：按累计获得而非余额排名，points 为累计获得而非余额
test('L2 花掉不掉名次：按累计获得而非余额（核心语义）', () => {
  // A 获得 100 后花 90（余额 10）；B 获得 50 不花（余额 50）——余额 A<B，但获得 A>B
  db.awardPoints(5201, 100, 'usage', 'l2-a-earn')
  assert.equal(db.spendPoints(5201, 90, 'redeem', 'l2-a-spend'), true, '扣分应成功（余额 100≥90）')
  db.awardPoints(5202, 50, 'usage', 'l2-b-earn')
  assert.equal(db.balance(5201), 10, 'A 余额 10')
  assert.equal(db.balance(5202), 50, 'B 余额 50（若按余额排，B 会在 A 前——反了）')
  // 排行榜按累计获得：A(获得100) 在 B(获得50) 之前
  const list = db.leaderboard(100)
  const ia = list.findIndex((e) => e.linuxdoId === 5201)
  const ib = list.findIndex((e) => e.linuxdoId === 5202)
  assert.ok(ia >= 0 && ib >= 0, 'A/B 均上榜')
  assert.ok(ia < ib, 'A（获得100）排在 B（获得50）之前——花掉不掉名次')
  assert.equal(list[ia].points, 100, 'A 的 points 为累计获得 100，非余额 10')
  // myRank 同口径
  assert.equal(db.myRank(5201).points, 100, 'myRank.points 亦为累计获得 100')
  assert.ok(db.myRank(5201).rank < db.myRank(5202).rank, 'A 名次优于 B')
})

// L3 上榜条件：无正 delta（纯扣减 / 无行）不上榜、myRank 返回 {rank:0, points:0}
test('L3 上榜条件：无正 delta 不上榜、myRank 返回 {rank:0,points:0}', () => {
  db.awardPoints(5301, -20, 'adjust', 'l3-c-neg') // C 只有负 delta（直接负值造扣减）
  // D(5302) 无任何 ledger 行
  const list = db.leaderboard(100)
  assert.ok(!list.some((e) => e.linuxdoId === 5301), '纯扣减用户不上榜（points=0）')
  assert.ok(!list.some((e) => e.linuxdoId === 5302), '无 ledger 行用户不上榜')
  assert.deepEqual(db.myRank(5301), { rank: 0, points: 0 }, '纯扣减 → {rank:0,points:0}')
  assert.deepEqual(db.myRank(5302), { rank: 0, points: 0 }, '无行 → {rank:0,points:0}')
})

// L4 username：子查询取该用户任一贡献号用户名；无贡献号则空串兜底
test('L4 username：子查询取贡献号用户名；无贡献号空串兜底', () => {
  seedContribution(5401, 'alice', 'l4-acc-f') // F 有贡献号 username='alice'
  db.awardPoints(5401, 40, 'usage', 'l4-f-earn')
  db.awardPoints(5402, 40, 'usage', 'l4-g-earn') // G 有获得分但无贡献号
  const list = db.leaderboard(100)
  const f = list.find((e) => e.linuxdoId === 5401)
  const g = list.find((e) => e.linuxdoId === 5402)
  assert.ok(f && g, 'F/G 均上榜')
  assert.equal(f!.username, 'alice', 'username 由子查询取到贡献号用户名')
  assert.equal(g!.username, '', '无贡献号 → 空串兜底')
})

// L5 同分 tie-break：首次入账早者靠前（MIN created_at ASC）。真实时钟间隔 10ms 令两者 created_at 严格不同——
// 负载下间隔只拉大不反转（H 的 award 先执行、时间戳恒早于 I），故非「卡紧阈值」的 flaky 测法。
test('L5 同分 tie-break：首次入账早者靠前（MIN created_at ASC）', async () => {
  db.awardPoints(5501, 50, 'usage', 'l5-h-earn')
  await sleep(10)
  db.awardPoints(5502, 50, 'usage', 'l5-i-earn')
  const list = db.leaderboard(100)
  const ih = list.findIndex((e) => e.linuxdoId === 5501)
  const ii = list.findIndex((e) => e.linuxdoId === 5502)
  assert.ok(ih >= 0 && ii >= 0, 'H/I 均上榜')
  assert.equal(list[ih].points, 50)
  assert.equal(list[ii].points, 50)
  assert.ok(ih < ii, '同累计获得下、首次入账早的 H 靠前')
})

// L6 同分名次一致性（核心回归，codex xhigh P2）：myRank 与 leaderboard 同全序 ⇒ 名次恒等于榜单位置 +1。
// 旧 bug：myRank 只数「严格多于我的人数」，同分被 tie-break 挤出前 20 者会误标名次 1（榜内同分者却占 1..20 位）。
test('L6 同分名次一致性：myRank.rank 恒等于榜单位置 +1', async () => {
  // 造 3 个新 uid 同累计获得 60，入账间隔 10ms 令 firstAt 严格递增（tie-break 走 firstAt、不落到 id 键）
  db.awardPoints(6601, 60, 'usage', 'l6-a')
  await sleep(10)
  db.awardPoints(6602, 60, 'usage', 'l6-b')
  await sleep(10)
  db.awardPoints(6603, 60, 'usage', 'l6-c')
  const list = db.leaderboard(100)
  // 三个同分者在榜单各占确定位置，名次＝位置+1（而非同标 1）
  for (const uid of [6601, 6602, 6603]) {
    const idx = list.findIndex((e) => e.linuxdoId === uid)
    assert.ok(idx >= 0, `uid ${uid} 应上榜`)
    assert.equal(db.myRank(uid).rank, idx + 1, `uid ${uid}：myRank 名次应＝榜单位置 ${idx + 1}`)
  }
  // 更强不变式：榜单上每一个用户（含 L1–L5 既有 uid，防口径回归），myRank.rank 恒等于其位置 +1
  list.forEach((e, i) => {
    assert.equal(db.myRank(e.linuxdoId).rank, i + 1, `榜单位置 ${i}（uid ${e.linuxdoId}）名次应＝${i + 1}`)
  })
})
