# P0-A · cpamp 能力探测结论

> 探测方式：从本机对真实 cpamp（Tailscale）**只读 GET** 试探，全程脱敏（真实号 accountId/email/token 不落文档）。日期：2026-07-15。
> 目的：核实需求依赖的 cpamp 能力、决定是否降级需求；封死 claude/grok 稳定 ID 规则。

## 连通性
本机可直连真实 cpamp 管理 API（`/v0/management/auth-files` HTTP 200）。

## 结论表

| 需求假设 | 结论 | 证据 |
|---|---|---|
| **入池优先级**（默认 10、越大越先） | 🟢 **可行，不降级** | CLIProxyAPI selector：`auth.Attributes["priority"]`（string→int，默认 0，`priority > bestPriority` 越大越先选）；`routing.strategy=fill-first` 按 priority 分桶。完全匹配需求。**待落地**：priority 写入方式 |
| **来源标记** | 🟢 **可行** | auth-file 有自由文本 `label` 字段（当前存了个邮箱），可写 hub 来源标记（PATCH 写操作待验，字段确在） |
| **claude 稳定 account_id** | 🟢 **有** | claude 记录含 `account`(len 14) + `id`(len 26) |
| **grok 稳定 account_id** | ⚪ 无样本 | 当前池无 grok 号，待样本 |
| **codex 稳定 account_id** | 🟢 有 | id_token 的 `chatgpt_account_id`（`cpa.ts` `parseIdToken` 已用） |
| **区分「手动禁用」vs 失效** | 🟡 有字段待验 | `disabled`(bool)/`status`/`status_message`/`unavailable`/`failed`/`success`；当前仅 1 个 active 号，无失效样本 |

## 稳定 ID 规则（P0-A 出口，封死）
- **codex**：`chatgpt_account_id`（id_token）→ 唯一键 `(codex, account_id)`
- **claude**：cpamp `account` 字段 → 唯一键 `(claude, account)`；**大概率免人工复核**（待确认重授权后 account 是否稳定）
- **grok**：待样本确认有无稳定 account；**若无 → 暂停接受 grok 或人工录入可永久复用、可验证的 canonical ID，绝不无标识放行**（守 v3「一号一辈子只交一次」）

## 软失败参考（P2b）
cpamp 自带：`request-retry=3`、`quota-exceeded` 处理选项、`transient-error-cooldown`、`session-affinity`(1h)。P2b 的软/硬/未知失败处理应**与之对齐**，避免和 cpamp 内建重试/冷却打架。

## 待落地 / 待样本（不阻塞 P0-B）
1. **priority 写入方式**：selector 只 `读` `Attributes["priority"]`，未见写入路径。P2c 落地时确认——auth 文件 JSON 字段 / cpamp 管理 API / Web UI（用户作为 cpamp 管理员或可直接确认 Web UI 能否设优先级）。
2. **禁用原因区分**：需一个失效/被禁号样本，验证 `disabled`/`status`/`status_message` 组合能否区分「手动禁用」vs 失效/限流。
3. **grok 稳定 ID**：需 grok 号样本。

## 探测边界（诚实）
优先级「写入方式」、禁用原因区分、grok 样本三项，只读探测 + 公开文档探不到底，留到 P2c 实现时（读加载源码 / 实测）或有样本时定。**均不阻塞 P0-B 基建启动。**

## 参考源
- CLIProxyAPI `sdk/cliproxy/auth/selector.go`（priority 选号逻辑）
- DeepWiki router-for-me/CLIProxyAPIPlus（tiered index / priority bucket）
- 真实 cpamp `/v0/management/config`（`routing.strategy=fill-first`）与 `/auth-files`（字段结构）
