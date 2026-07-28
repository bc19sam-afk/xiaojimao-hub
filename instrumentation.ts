// Next.js 启动钩子：服务启动时拉起后台巡检 worker。
// 仅在 Node 运行时执行（跳过 edge）。
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // env 的 fail-fast 仍然属于启动契约；DB/worker 的导入不能阻塞监听器建立。
    const { env } = await import('./lib/env')
    if (!env.worker.enabled) return

    // worker 会间接打开 SQLite。把它推到当前启动栈之后，schema 损坏/锁争用时仍让
    // /api/health 能先监听；worker 自己的导入失败只影响后台任务，不把整个进程带死。
    setImmediate(() => {
      void import('./lib/worker')
        .then(({ startWorker }) => startWorker())
        .catch(() => {
          // 具体异常可能含 DB 路径/内部细节；探针契约只需知道 worker 未启动。
          console.error('[worker] 启动失败（后台巡检未启动）')
        })
    })
  }
}
