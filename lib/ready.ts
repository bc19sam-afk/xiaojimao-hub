import { LATEST_VERSION } from './migrate'

// ============================================================================
// 就绪探针（readiness，P6-R2，§9）
//
// 与 /api/health（liveness，只证明进程活着）分工：
//   liveness  = 进程还在 → 不通就重启容器（镜像 HEALTHCHECK 用它）。
//   readiness = 这个进程**现在能正常干活吗** → 不通应把流量摘掉/告警，**但不该重启**
//               （schema 落后重启一万次也不会自己变好，只会进 churn 循环，故 HEALTHCHECK 不用它）。
//
// 判据四条,任一不满足即未就绪：
//   ① 应用常驻连接还能跑只读语句并读出 resident schema。
//   ② DB_PATH 仍存在，且 dev/inode 与这条常驻连接启动时打开的文件一致。
//   ③ 每次新开的只读连接能从 DB_PATH 当前磁盘状态读出 schema（补住常驻连接 page cache 假绿）。
//   ④ resident 与 disk schema 都 === 代码要求的 LATEST_VERSION。
//      ⚠️ 与 assertSchemaCurrent 的差别：那个是**启动期**守卫、超前只 warn 放行（向后兼容纪律）；
//      这里是**运行期**就绪信号，取严格相等——版本不一致时把流量摘走比继续服务安全，且这判断
//      不重启容器、无 churn 风险。
//
// 🔴 R6④（codex R5 指出）：`import { db }` 在模块顶层会触发 db.ts 的 openDb()，而 openDb 在
//    MOCK=false 时调 assertSchemaCurrent() ——那个在 schema 落后时**抛错**，导致本模块加载失败，
//    /api/ready 端点根本到不了「返回 503 {ok:false}」那步。修复：延迟导入 db，让 checkReady
//    能在 schema 落后时正常返回 false 而非模块加载崩溃。
//
// 🔴 §8 脱敏：本函数只返回布尔，绝不把版本号/路径/配置回给调用方；细节只进服务端日志。
// ============================================================================

// 就绪返回 true；任何异常（库坏、表缺、schema_version 多行抛错、**模块加载失败**）一律 false 且不外抛——
// 探针自身绝不能因为被探测对象坏了而 500。
export async function checkReady(): Promise<boolean> {
  try {
    // 🔴 延迟导入（R6④）：放函数内、不放模块顶层 → 在 MOCK=false 且 schema 落后时，import 本身会抛
    //   （openDb→assertSchemaCurrent），被本 try/catch 住、返回 false ✅；若在顶层 import，
    //   那个抛错会打断模块加载、/api/ready 路由注册不上 → 404 而非 503 {ok:false}。
    const { db } = await import('./db')
    const {
      alive,
      residentSchemaVersion,
      dbPathExists,
      dbPathMatchesOpenedFile,
      diskSchemaVersion,
    } = db.readyProbe()
    if (alive !== 1) {
      console.error('[ready] 未就绪：数据库只读探活未返回预期结果')
      return false
    }
    if (!dbPathExists) {
      console.error('[ready] 未就绪：数据库路径不存在')
      return false
    }
    if (!dbPathMatchesOpenedFile) {
      console.error('[ready] 未就绪：数据库路径已不再指向当前常驻连接打开的文件')
      return false
    }
    if (
      residentSchemaVersion !== LATEST_VERSION ||
      diskSchemaVersion !== LATEST_VERSION
    ) {
      // 日志里带版本号是可以的（服务端日志本就有 [migrate]/[db] 的版本行），响应体里不带。
      console.error(
        `[ready] 未就绪：schema 版本不匹配（常驻连接 ${residentSchemaVersion}，磁盘 ${diskSchemaVersion}，代码需要 ${LATEST_VERSION}）`,
      )
      return false
    }
    return true
  } catch (e) {
    console.error('[ready] 未就绪：探活出错：', e)
    return false
  }
}
