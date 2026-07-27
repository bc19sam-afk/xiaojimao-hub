import path from 'node:path'
import { checkPooledHealth, processPending } from './collect'
import { settleDailyUsage } from './settle'
import { dailyBackupIfDue } from './backup'
import { env } from './env'

// ============================================================================
// 后台自动巡检 worker
//
// 由 instrumentation.ts 在服务启动时拉起，周期性验证 pending 账号：
//   健康 → 启用 + 发兑换码；坏号 → 淘汰。无需人工点「立即验证」。
//
// ⚠️ 依赖常驻 Node 进程（next start 自托管 / dev）。serverless（Vercel）不适用，
//    那种环境要改用外部 cron 定时打 /api/verify-now。
// ============================================================================

let started = false

// ===== 每日自动备份（P6-R2，见 lib/backup.ts 的防 churn 说明）=====
// 备份路径口径与 scripts/backup.ts 逐字对齐（同一套 env 默认值），保证手动/自动两条入口写同一个目录。
function backupPaths(): { dbPath: string; dir: string; keep: number } {
  const keep = Number.parseInt(process.env.BACKUP_KEEP || '7', 10)
  return {
    dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db'),
    dir: process.env.BACKUP_DIR || path.join(process.cwd(), 'data', 'backups'),
    // 脏值兜底：backupDb 对 keep<1 会抛，自动备份不该因为 env 填错就每轮报错刷屏
    keep: Number.isInteger(keep) && keep >= 1 ? keep : 7,
  }
}

// 进程内「今天已确认过」的本地日。**纯性能优化**：日未变就不 readdir（8s 一 tick，一天上万次）。
// 权威判据始终是磁盘上的备份文件名（latestBackupDay）——重启后此变量清空，只是多 readdir 一次，
// 不会多备一份。🔴 绝不能反过来「靠它判断该不该备」，那样崩溃循环会备出一堆。
// 🔴 R6⑤（codex R5 指出）：缓存整天可能错过「今天备份被删/挂载点被换」→ 不创建替补 → 近一整天无快照。
//    修复：1 小时后重验磁盘（lastCheckedAt），兜「外部操作破坏备份」的窄窗（性能开销可忽略：一天
//    最多 24 次 readdir，远低于 10800 tick）。
let lastCheckedDay = ''
let lastCheckedAt = 0

// 每日备份闸：返回本轮是否真的备了一份（供测试断言与日志）。now 注入以可测。
//
// ⚠️ 已知代价（P6-R2 复审第 6 条，本轮**有意不改**）：backupDb 里的 `VACUUM INTO` 是
//    **同步**调用，跑的那一下会阻塞整个事件循环——期间 HTTP 请求不被处理。当前规模下可忽略：
//    真实库 76KB，VACUUM 耗时微秒级；复审实测 294MB 库要 489ms、49MB 要 85ms。
//    但这是**随库大小线性增长**的：库涨到几百 MB 时每天会有一次几百毫秒的全站卡顿，
//    那时就该把备份挪出主进程（独立 cron 容器 / worker_threads），而不是继续放在 tick 里。
//    判断阈值：`ls -la data/app.db` 超过 ~50MB 就该动手了。
export function runDailyBackup(now: Date = new Date()): boolean {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
  const nowMs = now.getTime()
  // R6⑤ 复查窗：即使今天已确认过，1 小时后也重新验盘（防「外部删除今天备份」窄窗）。
  const REVERIFY_MS = 3600_000 // 1 小时
  if (lastCheckedDay === today && nowMs - lastCheckedAt < REVERIFY_MS) return false
  const { dbPath, dir, keep } = backupPaths()
  const made = dailyBackupIfDue(now, dbPath, dir, keep)
  lastCheckedDay = today
  lastCheckedAt = nowMs
  return made
}

// 测试用：清空进程内的日缓存（生产无调用方）。不影响磁盘判据。
export function __resetBackupDayCache(): void {
  lastCheckedDay = ''
  lastCheckedAt = 0
}

// ===== dead-man 心跳（P6-R2）=====
// 节流：默认 tick 8s，不节流会把外部心跳服务打爆（同 collect.ts 的 HEALTH_INTERVAL_MS 模式）。
const HEARTBEAT_INTERVAL_MS = 5 * 60_000
let lastHeartbeatAt = 0

// 心跳 ping：仅在本轮三段全部没抛时调用（healthy=true）。任何失败只 warn——
// 心跳发不出去绝不能影响收号主链路。fetch 注入以可测。
export async function pingHeartbeat(
  healthy: boolean,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!env.worker.heartbeatUrl) return false // 未配置＝关闭
  if (!healthy) return false // 本轮有段抛错＝这轮不算「一切正常」，不 ping（让外部超时告警）
  if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return false // 节流
  lastHeartbeatAt = now // 先记时刻：失败也不在窗内立刻重试（防外部故障时每 8s 猛敲）
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5000) // 5s 超时：外部服务卡住不许拖住 tick
  try {
    const res = await fetchImpl(env.worker.heartbeatUrl, { method: 'GET', signal: ac.signal })
    // 🔴 R6-P2⑤（codex R5 终审）：非 2xx 不算发送成功。
    //    fetch 只在网络层失败时 reject，HTTP 错误状态是**正常 resolve** 的——修复前 404（URL 里的
    //    uuid 打错/心跳监视器被删）、401（token 失效）、5xx（监视服务自身故障）全都返回 true，
    //    日志一声不响。而这类配置错恰恰是**静默的**：外部监视器收不到 ping → 到期告警，运维查
    //    本地日志却看不到任何异常，只能反推。故按 res.ok 判定，非 2xx 记 warn 并返回 false。
    //    ⚠️ 返回 false 只表示「这次心跳没送达」，不影响收号主链路（调用方只记日志，见 tick）。
    if (!res.ok) {
      // 🔴 §8：只记状态码，绝不回显心跳 URL（含 uuid 型密钥）或响应体（可能回显 URL/token）
      console.warn(`[worker] 心跳发送失败（不影响巡检）：HTTP ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    // 🔴 §8：只记「失败」与错误对象，绝不回显心跳 URL（含 uuid 型密钥）
    console.warn('[worker] 心跳发送失败（不影响巡检）：', e)
    return false
  } finally {
    clearTimeout(timer)
  }
}

// 测试用：清空节流时刻（生产无调用方）
export function __resetHeartbeatThrottle(): void {
  lastHeartbeatAt = 0
}

// 首检结果 → 本轮是否算「收号链路正常」（心跳前提）。抽成函数只为可测：tick 是闭包，
// 里面的 healthy 判定没有别的入口能断言。
//
// 🔴 首检 skipped 也算不健康（P6-R2 复审第 7 条）：processPending 的 running 锁没释放时它返回
//    { skipped:true } 而**不抛**——上一轮卡在某个 await（cpamp 连接吊死等）就会一直如此。
//    只 catch 异常的话 healthy 恒 true、心跳照打，dead-man 反而在「worker 真的不干活了」时保持
//    沉默，正是它该报警的那个场景。
// ⚠️ 只并**首检**这一段的 skipped，另两段的不并——它们的 skipped 是正常节流，语义完全不同：
//    实测（8s tick、一天 10800 轮）checkPooledHealth 因 5 分钟节流 skip 掉 97.33% 的轮次，
//    settleDailyUsage 因 grace 窗 + 一天一次 skip 掉 99.99%。三段都并进去的话「三段同时真跑」
//    一天只有 1 轮 → 心跳一天最多 1 次，而外部 Period 建议 5 分钟 → 恒定误报。
//    只有首检的 skipped 是纯锁语义（＝真的卡住了），故只采纳这一段。
//
// 🔴 CPA 整体故障也算不健康（P6-R2 复审三轮第 2 条）：cpamp 巡检接口挂了（5xx/网络不通）时
//    processPending 内部 catch 住、把本轮 codex 待检号全跳过——这是 PR #15 定的收号纪律
//    （「不可观测」绝不能误退回好号），**语义不能改**。但它因此一路返回
//    { checked:n, activated:0, rejected:0 } 且不抛 → healthy 恒 true → 心跳照打，
//    而收号链路实际上是断的（号一个也进不了池）。docs §6 承诺「心跳证明后台 worker 还在正常
//    干活」，这就是实测复现过的那条假绿。故 processPending 额外回一个纯健康信号 inspectFailed，
//    在这里消费：收号语义分毫未动，只是让 dead-man 能看见 CPA 挂了。
//    ⚠️ 缺省 undefined ＝本轮压根没调 inspect（没有 codex 待检号）＝没有可观测到的 CPA 故障，
//       按健康算——绝不能因为「本轮没活干」就误报不健康（那会让心跳恒不发）。
// 🔴 CPA 写失败也算不健康（P6-R2 R6③，codex R5 指出）：setDisabled/deleteAuthFile/setPriority
//    抛错时 enterPool/rejectBack 内部 catch 住、留行待重试，**不抛**（收号纪律不变）。
//    processPending 返回时只回传 activated/rejected 计数、无失败信号 → healthy 恒 true → 心跳照打，
//    而 CPA 写端点故障会阻塞所有激活/拒绝（待检号堆积、零号入池）。同理额外传播 writeFailed 健康信号。
export function pendingIsHealthy(r: { skipped?: boolean; inspectFailed?: boolean; writeFailed?: boolean }): boolean {
  return !r.skipped && !r.inspectFailed && !r.writeFailed
}

// 存活巡检结果 → 本轮是否算「存活巡检链路正常」。抽成函数的理由同 pendingIsHealthy / settleIsHealthy：
// tick 是闭包，不抽出来就没有入口能断言这条判据。
// 🔴 只看 lockHeld 和 inspectFailed，**不看 skipped**（P6-R2 R4② + R6②，codex R5 补全）：
//    checkPooledHealth 的 skipped 有两个来源，只有 healthRunning 锁那一个代表「上一轮卡在某个
//    await 没回来」（cpa.inspect / listAuthFiles 的无超时 fetch）；另一个（5 分钟节流）是正常行为，
//    实测占 97% 的轮次——并进健康判据＝心跳几乎不发、恒定误报。
//    inspectFailed（R6②）与 processPending 的同名字段同根因：CPA 巡检接口（inspect / listAuthFiles）
//    5xx/网络不通时 catch 块吞掉异常、跳过本轮所有号（存活巡检纪律：不可观测≠失效，绝不误停），
//    **但不抛**。lastHealthAt 在 try 前已推进 → 后续 tick 被当正常节流 skip、继续发心跳，
//    而存活巡检实际断了。故额外传播此健康信号。
//    ⚠️ 缺省 undefined ＝本轮无 pooled 号/全是 codex 且 inspect 成功 → 按健康算，不能因
//       「本轮没活干」就误报不健康（那会让心跳恒不发）。
export function healthIsHealthy(h: { skipped?: boolean; lockHeld?: boolean; inspectFailed?: boolean }): boolean {
  return !h.lockHeld && !h.inspectFailed
}

// 结算结果 → 本轮是否算「结算链路正常」。抽成函数的理由同 pendingIsHealthy：tick 是闭包，不抽出来
// 就没有入口能断言这条判据。
// 🔴 只看 lockHeld，**不看 skipped**（P6-R2 复审三轮第 3 条）：settleDailyUsage 的 skipped 有三个
//    来源，只有 running 锁那一个代表「上一轮卡在某个 await 没回来」；另两个（日切 grace 窗 /
//    今天已结过）是正常节流，实测占 99.99% 的轮次，并进去＝心跳一天最多 1 次、恒定误报。
export function settleIsHealthy(s: { skipped?: boolean; lockHeld?: boolean }): boolean {
  return !s.lockHeld
}

export function startWorker() {
  if (started) return // 防重复启动（dev 热更可能多次触发）
  if (!env.worker.enabled) {
    console.log('[worker] 已禁用（WORKER_ENABLED=false）')
    return
  }
  started = true

  const tick = async () => {
    // 本轮三段（首检/存活巡检/结算）是否全部没抛——dead-man 心跳的前提：有段抛错就不 ping，
    // 让外部服务在约定超时后告警。备份段（第四段）不计入：备份失败该单独告警，不该把
    // 「收号链路正常」的信号也一起掐掉（会掩盖真正的主链路故障判断）。
    let healthy = true
    try {
      const r = await processPending()
      // 三种「没抛但收号链路不正常」的情形都掐掉本轮心跳（理由见 pendingIsHealthy 上的说明）。
      // 分开记日志：每条指向具体故障——排障方向完全不同，合成一句话会把运维引到错的那一边。
      if (!pendingIsHealthy(r)) {
        healthy = false
        if (r.skipped) console.warn('[worker] 首检被上一轮的锁挡住（可能卡死），本轮不发心跳')
        if (r.inspectFailed) console.warn('[worker] CPA 巡检接口不可用，待检号本轮全跳过，本轮不发心跳')
        if (r.writeFailed) console.warn('[worker] CPA 写操作失败（setDisabled/deleteAuthFile/setPriority），激活/拒绝阻塞，本轮不发心跳')
      }
      if (r.activated || r.rejected) {
        console.log(`[worker] 巡检完成：通过 ${r.activated}，淘汰 ${r.rejected}`)
      }
    } catch (e) {
      healthy = false
      console.error('[worker] 巡检出错：', e)
    }
    // 号存活巡检（P2-R3）：pooled 号明确失效 → stopped。独立 try/catch，巡检故障不拖累首检/结算；
    // 与首检共用同一 tick 周期、各自 running 锁防叠跑。放结算前：本轮先停失效号，再结历史日欠薪。
    try {
      const h = await checkPooledHealth()
      // 🔴 只认 lockHeld 和 inspectFailed，不认 skipped（P6-R2 R4② + R6②）：checkPooledHealth 的 skipped
      //    有两个来源，只有 healthRunning 锁那一个代表「上一轮卡在某个 await 没回来」。另一个（5 分钟节流）
      //    是正常节流，实测占 97% 的轮次——并进健康判据＝心跳几乎不发、恒定误报。
      //    inspectFailed（R6②）与首检段同根因：CPA 巡检接口挂了，catch 块跳过本轮所有号但不抛 → 后续 tick
      //    被当正常节流 skip、继续发心跳，而存活巡检实际断了。分开记日志便于排障。
      if (!healthIsHealthy(h)) {
        healthy = false
        if (h.lockHeld) console.warn('[worker] 存活巡检被上一轮的锁挡住（可能卡死），本轮不发心跳')
        if (h.inspectFailed) console.warn('[worker] CPA 巡检接口（inspect/listAuthFiles）不可用，pooled 号本轮全跳过，本轮不发心跳')
      }
      if (h.stopped) {
        console.log(`[worker] 存活巡检：停用 ${h.stopped} 个失效号`)
      }
    } catch (e) {
      healthy = false
      console.error('[worker] 存活巡检出错：', e)
    }
    // 首检入池后，按日用量结算（P2-R2）：拉 cpamp 每日调用量 → pooled 号折算发分。独立 try/catch，
    // 结算故障不拖累首检；两者共用同一 tick 周期，各自 running 锁防叠跑。
    try {
      const s = await settleDailyUsage()
      // 🔴 只认 lockHeld，不认 skipped（P6-R2 复审三轮第 3 条）：settleDailyUsage 的 skipped 有三个来源，
      //    只有 running 锁那一个代表「上一轮卡在某个 await 没回来」。另两个（日切 grace 窗 / 今天已结过）
      //    是正常节流，实测占 99.99% 的轮次——并进健康判据＝心跳一天最多 1 次、恒定误报。详见 settle.ts
      //    返回类型上的说明。
      if (!settleIsHealthy(s)) {
        healthy = false
        console.warn('[worker] 结算被上一轮的锁挡住（可能卡死），本轮不发心跳')
      }
      if (s.settled || s.awarded) {
        console.log(`[worker] 按日结算：结算 ${s.settled} 笔，发分 ${s.awarded} 笔`)
      }
    } catch (e) {
      healthy = false
      console.error('[worker] 结算出错：', e)
    }
    // 每日自动备份（P6-R2）：升级期备份只在「有待迁移」时才跑，不升级的日子数据没有任何快照。
    // 独立 try/catch：备份失败（磁盘满/权限错）只记日志，绝不拖累首检/巡检/结算。
    try {
      if (runDailyBackup()) console.log('[worker] 每日自动备份完成')
    } catch (e) {
      console.error('[worker] 每日备份出错：', e)
    }
    // dead-man 心跳（P6-R2）：三段全成才 ping，节流 5 分钟。未配置 HEARTBEAT_URL 时是空操作。
    await pingHeartbeat(healthy)
  }

  // 启动 3s 后首跑，避免和服务启动争抢；之后按间隔循环
  setTimeout(tick, 3000)
  setInterval(tick, env.worker.intervalMs)
  console.log(`[worker] 后台巡检已启动，每 ${Math.round(env.worker.intervalMs / 1000)}s 一次`)
}
