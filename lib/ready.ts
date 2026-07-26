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
//   ① 库连接还能跑只读语句（SELECT 1）+ 读出 schema 版本——连接已关闭、库已损坏到读不出版本行时抛错。
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
    // ⚠️ 这条分支**实测打不到**（P6-R2 复审第 8 条）：`SELECT 1` 是常量表达式，SQLite 压根不碰
    //    库文件，只要连接没关就恒返回 1。实测六种坏法的真实去向（细节见 lib/db.ts readyProbe 注释）：
    //      库文件被删 / 换成另一个库 / 头完好但数据页砸烂 → alive=1 且版本号照旧 → 本探针**放行**
    //      截断到只剩头 / 整文件覆盖 / 连接已 close       → 读版本那步抛错 → 走下面的 catch ✅
    //    即：真正兜住「库坏了」的是 catch 和 schemaVersion 比对，不是这个 alive 判断；且只兜得住
    //    「坏在文件头/整体结构」那半边。保留 alive 判断是**廉价的契约断言**（readyProbe 返回形状变了
    //    能就地暴露），不是有效的坏库探测。
    //    🔴 别据此以为 readiness 能发现「库文件被删/被换/数据页损坏」——这三种它发现不了；那类故障
    //       靠的是写入路径自己抛错 + 外部拨测，以及恢复流程里的 quick_check（scripts/restore.sh）。
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
