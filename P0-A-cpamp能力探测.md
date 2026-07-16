# P0-A · cpamp 能力探测结论

> 探测方式：从本机对真实 cpamp（Tailscale）**只读 GET** 试探，全程脱敏（真实号 accountId/email/token 不落文档）。日期：2026-07-15。
> 目的：核实需求依赖的 cpamp 能力、决定是否降级需求；封死 claude/grok 稳定 ID 规则。

## 连通性
本机可直连真实 cpamp 管理 API（`/v0/management/auth-files` HTTP 200）。

## 结论表

| 需求假设 | 结论 | 证据 |
|---|---|---|
| **入池优先级**（默认 10、越大越先） | 🟢 **可行，不降级** | CLIProxyAPI selector：`auth.Attributes["priority"]`（string→int，默认 0，`priority > bestPriority` 越大越先选）；`routing.strategy=fill-first` 按 priority 分桶。完全匹配需求。**cpamp 确认可给单号设优先级**（用户 2026-07-15 确认）；具体 API/字段 P2c 对接 |
| **来源标记** | 🟢 **可行** | auth-file 有自由文本 `label` 字段（当前存了个邮箱），可写 hub 来源标记（PATCH 写操作待验，字段确在） |
| **claude 稳定 account_id** | 🟢 **有** | claude 记录含 `account`(len 14) + `id`(len 26) |
| **grok 稳定 account_id** | 🟢 **有＝`sub`** | CLIProxyAPI `internal/auth/xai/token.go` 的 TokenStorage 有 `Subject string json:"sub"`（OIDC subject，稳定唯一）；xai 走全套 OIDC（scope 含 openid + id_token）。auth 文件顶层扁平 `sub` 字段、与 email 平级。2026-07-16 扒源码确认（非样本） |
| **codex 稳定 account_id** | 🟢 有 | id_token 的 `chatgpt_account_id`（`cpa.ts` `parseIdToken` 已用） |
| **区分「手动禁用」vs 失效** | 🟡 有字段待验 | `disabled`(bool)/`status`/`status_message`/`unavailable`/`failed`/`success`；当前仅 1 个 active 号，无失效样本 |

## 稳定 ID 规则（P0-A 出口，封死）
- **codex**：`chatgpt_account_id`（id_token）→ 唯一键 `(codex, account_id)`
- **claude**：cpamp `account` 字段 → 唯一键 `(claude, account)`；**大概率免人工复核**（待确认重授权后 account 是否稳定）
- **grok**：稳定 ID ＝ **`sub`**（OIDC subject，auth 文件顶层字段）——源码实锤（CLIProxyAPI `internal/auth/xai/token.go` TokenStorage.Subject）。与 codex(`chatgpt_account_id`)、claude(`account`) 同类；normFile 加 `sub` fallback（限 grok）即可正常接、正常发分。OIDC sub 规范上跨重授权稳定，稳定性优于 claude 的 account。**「暂停接受 grok」的旧保守假设作废。**

## 软失败参考（P2b）
cpamp 自带：`request-retry=3`、`quota-exceeded` 处理选项、`transient-error-cooldown`、`session-affinity`(1h)。P2b 的软/硬/未知失败处理应**与之对齐**，避免和 cpamp 内建重试/冷却打架。

## codex-inspection 巡检能力（P2 考察期核心依据，2026-07-16 扒 cpamp 本体文档）
**关键结论：账号健康判定不用自造——cpamp codex-inspection 已做好，worker 只需周期调它、把建议动作翻译成观测事件。**
- 检查内容：计划/配额窗口/重置时间/剩余额度、OAuth 是否失效、工作区状态、是否 `usage_limit_reached`、是否需重授权/恢复/禁用。
- **建议动作 → 观测 kind 映射**（`cpa.ts` ProbeDecision 已部分对接，P2b 做实）：
  - 保留 keep（≈ ok）→ **healthy**
  - 禁用 disable（≈ retry，额度超阈/状态异常）→ **soft_fail**（不阻断发分）
  - 重新登录 relogin（≈ reauth，OAuth 失效）→ **needs_review**（需重授权，人工/作废）
  - 删除 delete（≈ reject，明确失效）→ **hard_fail**（判死）
- **两条需求原则被 cpamp 官方印证（对接不打架）**：① 「缺失字段按未知处理、不当健康也不当异常」＝需求 §3.2「未知不算失败」；② 「手动禁用的账号不会被自动恢复覆盖」＝需求 §3.3「管理员手动禁用不算账号失败」。
- cpamp 支持**服务端定时巡检 + 历史记录**（固定间隔/每天定点，下个 worker 周期生效）；我们 worker 自轮询 inspect 也行（`cpa.ts` 已在做），定时巡检为备选。官方「定时巡检任务系统」(`feat/codex-inspection-tasks`) 未正式发布。
- 源：`seakee/CPA-Manager-Plus` `apps/docs/manual/codex-inspection.md`；`poterpan/cpa-codex-inspection-bridge`。

## 待落地 / 待样本（不阻塞 P0-B）
1. **priority 写入方式**：**cpamp 确认支持给单号设优先级**（用户 2026-07-15 确认）；走哪个 API/字段留 P2c 对接时定。
2. **禁用原因区分**：需一个失效/被禁号样本，验证 `disabled`/`status`/`status_message` 组合能否区分「手动禁用」vs 失效/限流。
3. ~~**grok 稳定 ID**：需样本~~ **已解决 ＝ `sub`**（2026-07-16 扒 CLIProxyAPI `internal/auth/xai/token.go` + 社区 `Git-creat7/grokRegister-cpa` 确认）。落地：normFile 加 grok 的 `sub` fallback。

## 探测边界（诚实）
优先级「写入方式」、禁用原因区分、grok 样本三项，只读探测 + 公开文档探不到底，留到 P2c 实现时（读加载源码 / 实测）或有样本时定。**均不阻塞 P0-B 基建启动。**

## 参考源
- CLIProxyAPI `sdk/cliproxy/auth/selector.go`（priority 选号逻辑）
- DeepWiki router-for-me/CLIProxyAPIPlus（tiered index / priority bucket）
- 真实 cpamp `/v0/management/config`（`routing.strategy=fill-first`）与 `/auth-files`（字段结构）
