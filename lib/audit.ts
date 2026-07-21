import type { PointRule, RedeemItem } from './db'

// ============================================================================
// 审计条目构造器（P4-R1，§7.3）：把每个 admin 写入点的「旧值→新值」规整成 { action, target, old, new }
// 纯摘要，交给 db.recordAudit 落 audit_log。纯函数、无 DB / Next 依赖 → 可直测（尤其 §8 脱敏铁律）。
//
// ⚠️ 脱敏铁律（§8「完整 CDK / RT / 管理密钥不写日志」）：old/new 只记**配置级/计数级摘要**，绝不记敏感原文。
//   - CDK 导入：函数签名压根不收 codes → 结构上不可能泄码，只记「导入 N / 跳过 M（面额 F）+ 库存计数」。
//   - 发分规则 / 兑换项 / 额度：本就是配置数值（provider/plan/分值/价/额度），非敏感，原样记可对比。
// ============================================================================

export interface AuditEntry {
  action: string
  target: string
  old?: unknown // 无旧值（如新建）时省略 → recordAudit 落 null
  new?: unknown // 无新值（如删除）时省略 → recordAudit 落 null
}

// ---- 发分规则 point_rules ----
function ruleSummary(r: PointRule) {
  return { provider: r.provider, plan: r.plan, points: r.points, enabled: r.enabled, label: r.label }
}
// next 为已规整（provider/plan 已小写，与落库/唯一键一致）的入参
export function auditPointRuleUpsert(
  old: PointRule | undefined,
  next: { provider: string; plan: string; points: number; enabled: boolean; label: string },
): AuditEntry {
  return {
    action: 'point_rule.upsert',
    target: `${next.provider}/${next.plan}`,
    old: old ? ruleSummary(old) : undefined,
    new: { provider: next.provider, plan: next.plan, points: next.points, enabled: next.enabled ? 1 : 0, label: next.label },
  }
}
export function auditPointRuleDelete(old: PointRule | undefined, id: number): AuditEntry {
  return {
    action: 'point_rule.delete',
    target: old ? `${old.provider}/${old.plan}` : `#${id}`,
    old: old ? ruleSummary(old) : undefined,
  }
}

// ---- 兑换项 redeem_items ----
function itemSummary(it: RedeemItem) {
  return {
    name: it.name,
    cost: it.cost,
    kind: it.kind,
    enabled: it.enabled,
    sort: it.sort,
    fulfillment: it.fulfillment,
    perUserLimit: it.perUserLimit,
    description: it.description,
  }
}
export function auditRedeemItemUpsert(
  old: RedeemItem | undefined,
  next: {
    id?: number
    name: string
    cost: number
    kind: string
    enabled: boolean
    sort: number
    fulfillment?: string
    perUserLimit?: number
    description: string
  },
): AuditEntry {
  return {
    action: 'redeem_item.upsert',
    target: next.id ? `item#${next.id}(${next.name})` : `item(${next.name})`,
    old: old ? itemSummary(old) : undefined,
    new: {
      name: next.name,
      cost: next.cost,
      kind: next.kind,
      enabled: next.enabled ? 1 : 0,
      sort: next.sort,
      fulfillment: next.fulfillment,
      perUserLimit: next.perUserLimit,
      description: next.description,
    },
  }
}
export function auditRedeemItemDelete(old: RedeemItem | undefined, id: number): AuditEntry {
  return {
    action: 'redeem_item.delete',
    target: old ? `item#${id}(${old.name})` : `item#${id}`,
    old: old ? itemSummary(old) : undefined,
  }
}

// ---- CDK 库存导入（§8：只记计数摘要，绝不记码本身）----
// 签名不含 codes ⇒ 结构上不可能把码写进 audit。faceValue 是配置级面额（非敏感）；库存 before/after 便于回看变化。
export function auditCdkImport(args: {
  itemId: number
  itemName: string
  faceValue: number | null
  imported: number
  skipped: number
  availableBefore: number
  availableAfter: number
}): AuditEntry {
  return {
    action: 'cdk.import',
    target: `item#${args.itemId}(${args.itemName})`,
    old: { available: args.availableBefore },
    new: {
      imported: args.imported,
      skipped: args.skipped,
      faceValue: args.faceValue,
      available: args.availableAfter,
    },
  }
}

// ---- LDC 每日额度 ----
export function auditLdcQuota(oldQuota: number, newQuota: number): AuditEntry {
  return {
    action: 'ldc_quota.set',
    target: 'ldc_daily_quota',
    old: oldQuota,
    new: newQuota,
  }
}
