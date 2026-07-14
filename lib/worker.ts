import { processPending } from './collect'
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
    try {
      const r = await processPending()
      if (r.activated || r.rejected) {
        console.log(`[worker] 巡检完成：通过 ${r.activated}，淘汰 ${r.rejected}`)
      }
    } catch (e) {
      console.error('[worker] 巡检出错：', e)
    }
  }

  // 启动 3s 后首跑，避免和服务启动争抢；之后按间隔循环
  setTimeout(tick, 3000)
  setInterval(tick, env.worker.intervalMs)
  console.log(`[worker] 后台巡检已启动，每 ${Math.round(env.worker.intervalMs / 1000)}s 一次`)
}
