// Next.js 启动钩子：服务启动时拉起后台巡检 worker。
// 仅在 Node 运行时执行（跳过 edge）。
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startWorker } = await import('./lib/worker')
    startWorker()
  }
}
