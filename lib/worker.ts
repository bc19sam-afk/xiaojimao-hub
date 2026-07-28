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

export function startWorker() {
  if (started) return // 防重复启动（dev 热更可能多次触发）
  if (!env.worker.enabled) {
    console.log('[worker] 已禁用（WORKER_ENABLED=false）')
    return
  }
  started = true

  const tick = async () => {
    // 延迟加载 DB 依赖：服务监听与 liveness/readiness 不应被坏库的模块求值阻断。
    // 模块成功加载后由 ESM cache 复用，不会每轮重新执行文件。
    let processPending: typeof import('./collect').processPending
    let checkPooledHealth: typeof import('./collect').checkPooledHealth
    let settleDailyUsage: typeof import('./settle').settleDailyUsage
    try {
      ;({ processPending, checkPooledHealth } = await import('./collect'))
    } catch {
      console.error('[worker] 收号模块加载失败（后台巡检本轮跳过）')
      return
    }
    try {
      ;({ settleDailyUsage } = await import('./settle'))
    } catch {
      console.error('[worker] 结算模块加载失败（后台巡检本轮跳过）')
      return
    }

    try {
      const r = await processPending()
      if (r.activated || r.rejected) {
        console.log(`[worker] 巡检完成：通过 ${r.activated}，淘汰 ${r.rejected}`)
      }
    } catch (e) {
      console.error('[worker] 巡检出错：', e)
    }
    // 号存活巡检（P2-R3）：pooled 号明确失效 → stopped。独立 try/catch，巡检故障不拖累首检/结算；
    // 与首检共用同一 tick 周期、各自 running 锁防叠跑。放结算前：本轮先停失效号，再结历史日欠薪。
    try {
      const h = await checkPooledHealth()
      if (h.stopped) {
        console.log(`[worker] 存活巡检：停用 ${h.stopped} 个失效号`)
      }
    } catch (e) {
      console.error('[worker] 存活巡检出错：', e)
    }
    // 首检入池后，按日用量结算（P2-R2）：拉 cpamp 每日调用量 → pooled 号折算发分。独立 try/catch，
    // 结算故障不拖累首检；两者共用同一 tick 周期，各自 running 锁防叠跑。
    try {
      const s = await settleDailyUsage()
      if (s.settled || s.awarded) {
        console.log(`[worker] 按日结算：结算 ${s.settled} 笔，发分 ${s.awarded} 笔`)
      }
    } catch (e) {
      console.error('[worker] 结算出错：', e)
    }
  }

  // 启动 3s 后首跑，避免和服务启动争抢；之后按间隔循环
  setTimeout(tick, 3000)
  setInterval(tick, env.worker.intervalMs)
  console.log(`[worker] 后台巡检已启动，每 ${Math.round(env.worker.intervalMs / 1000)}s 一次`)
}
