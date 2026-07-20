import { createHash, randomBytes } from 'crypto'
import { db } from './db'

// ============================================================================
// 兑换：花积分换东西。P3-R1 起，占码 → 扣分 → 写记录在 db.performRedeem 的单事务内完成
// （§5.5「同成功或同失败」）。本模块负责两件事：
//   ① 算**确定性幂等键**（挡重复点击 / 超时重试导致的重复扣分）；
//   ② 按履约类型路由：cdk 发码（事务内占用的码即结果）/ placeholder 占位（给一个占位串）。
// ============================================================================

// 占位履约（非发码类）：按展示分类给一个占位结果串。将来某类要真发码＝后台把该项 fulfillment 改 'cdk' + 导码。
function fulfillPlaceholder(kind: string): string {
  switch (kind) {
    case 'invite_code':
      return `XJM-INV-${randomBytes(3).toString('hex').toUpperCase()}`
    default:
      return '已发放（占位，待接小鸡毛履约）'
  }
}

// 后台导入用：把「一行一码 / 逗号 / 空白分隔」的原始文本或数组，规整成去空、trim、去重后的码数组。
// 纯函数、无 DB 依赖，便于单测（admin 导入 API 的解析逻辑即此）。db.importCdkCodes 再按 (item_id, code)
// 唯一键做落库级去重（跨批次防重）。
export function parseCdkCodes(raw: string | string[]): string[] {
  // 换行 / 逗号 / 空白（空格·tab）皆作分隔符——§5.3 文档承诺「一行一码 / 逗号 / 空白分隔」，漏空格会把
  // 「CODE-1 CODE-2」当成一个码整串入库、之后发出不可用拼接码（codex+bot 复审 P2）。
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of parts) {
    const code = String(p).trim()
    if (!code || seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

// 幂等键短窗（token 缺失时的服务端兜底）：同一 (用户, 项) 在窗口内的重复请求折叠成一次。
// 正常客户端每次兑换手势带独立 token（见 RedeemStore，crypto.randomUUID 每项一枚），几乎不会走到兜底；
// 仅裸 API / 旧缓存客户端命中。⚠️ 固定时间桶是 best-effort：跨桶边界（如 9.9s / 10.1s）的无 token 重放会
// 落不同桶、不折叠 → 可双花（codex 复审 P1）。无客户端稳定键时无法根治，故仅作弱兜底——真正的重复兑换
// 防护靠客户端必带 token（已保证）。根治（如失败也落库回放 / 服务端请求指纹）留后续 task。
const IDEM_WINDOW_MS = 10_000

// 确定性幂等键 → redemptionId（既作 redemptions 主键，又作 point_ledger 的 ref）。
//   有 token：tok:<uid>:<itemId>:<token>（含 itemId，防同 token 跨项被误判为回放）；
//   无 token：auto:<uid>:<itemId>:<窗口桶>。SHA-256 收敛长度、规整任意客户端串（不把原始 token 落进主键/日志）。
function redemptionIdFor(linuxdoId: number, itemId: number, token: string | undefined, now: number): string {
  const t = typeof token === 'string' ? token.trim() : ''
  const base = t
    ? `tok:${linuxdoId}:${itemId}:${t}`
    : `auto:${linuxdoId}:${itemId}:${Math.floor(now / IDEM_WINDOW_MS)}`
  return 'rdm_' + createHash('sha256').update(base).digest('hex').slice(0, 32)
}

export function redeem(
  linuxdoId: number,
  itemId: number,
  opts: { token?: string; now?: number } = {},
): { ok: true; result: string; balance: number } | { ok: false; error: string } {
  const item = db.getRedeemItem(itemId)
  if (!item || item.enabled === 0) return { ok: false, error: '该兑换项不存在或已下架' }

  const now = opts.now ?? Date.now()
  const redemptionId = redemptionIdFor(linuxdoId, itemId, opts.token, now)
  // cdk 类结果＝事务内占用的码（此处传空占位）；placeholder 类先算好占位串带进事务写记录。
  const placeholderResult = item.fulfillment === 'cdk' ? '' : fulfillPlaceholder(item.kind)

  const res = db.performRedeem({ linuxdoId, redemptionId, item, placeholderResult })
  if (!res.ok) return res
  return { ok: true, result: res.result, balance: res.balance }
}
