import { db } from './db'
import { LATEST_VERSION } from './migrate'

// ============================================================================
// 就绪探针（readiness，P6-R2，§9）
//
// 与 /api/health（liveness，只证明进程活着）分工：
//   liveness  = 进程还在 → 不通就重启容器（镜像 HEALTHCHECK 用它）。
//   readiness = 这个进程**现在能正常干活吗** → 不通应把流量摘掉/告警，**但不该重启**
//               （schema 落后重启一万次也不会自己变好，只会进 churn 循环，故 HEALTHCHECK 不用它）。
//
// 判据两条，任一不满足即未就绪：
//   ① 库连接还能跑只读语句（SELECT 1）——库文件被删/换/损坏、连接已关，这条就挂。
//   ② schema 版本 === 代码要求的 LATEST_VERSION——落后（漏跑 migrate）或超前（代码回滚）都算未就绪。
//      ⚠️ 与 assertSchemaCurrent 的差别：那个是**启动期**守卫、超前只 warn 放行（向后兼容纪律）；
//      这里是**运行期**就绪信号，取严格相等——版本不一致时把流量摘走比继续服务安全，且这判断
//      不重启容器、无 churn 风险。
//
// 🔴 §8 脱敏：本函数只返回布尔，绝不把版本号/路径/配置回给调用方；细节只进服务端日志。
// ============================================================================

// 就绪返回 true；任何异常（库坏、表缺、schema_version 多行抛错）一律 false 且不外抛——
// 探针自身绝不能因为被探测对象坏了而 500。
export function checkReady(): boolean {
  try {
    const { alive, schemaVersion } = db.readyProbe()
    if (alive !== 1) {
      console.error('[ready] 未就绪：数据库只读探活未返回预期结果')
      return false
    }
    if (schemaVersion !== LATEST_VERSION) {
      // 日志里带版本号是可以的（服务端日志本就有 [migrate]/[db] 的版本行），响应体里不带。
      console.error(
        `[ready] 未就绪：schema 版本不匹配（当前 ${schemaVersion}，代码需要 ${LATEST_VERSION}）`,
      )
      return false
    }
    return true
  } catch (e) {
    console.error('[ready] 未就绪：探活出错：', e)
    return false
  }
}
