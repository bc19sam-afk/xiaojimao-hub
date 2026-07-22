# cpamp 真实实例只读探测 · realClient 占位字段核对报告（R1）

> 本轮性质：**纯只读探测 + 核对报告**，不改任何 real 代码。目的：拿真实 cpamp 响应逐条核对
> `lib/cpa.ts` realClient 里标了 `TODO(对接)` 的占位字段假设，产出「对得上 / 需改 / 未核」结论，
> 供下一轮决定 real 代码改法。
>
> 探测日期：2026-07-22 ｜ 工具：`scripts/probe-cpamp.ts`（本 PR 一并提交）
>
> **红线合规声明**：全程仅 HTTP **GET**（`GET /v0/management/auth-files`、`/usage`、`/config`），
> `rawGet` 里 method 写死、脚本内无任何 POST/PATCH/PUT/DELETE；**未调**
> `setDisabled/deleteAuthFile/ingest*/*OAuth/inspect` 等任何写方法；**未碰实例里那个真实 claude 号的
> 任何状态**（未禁用/未删除/未改优先级）。所有输出经 `safe()` 递归脱敏——RT/access_token/id_token/
> 管理密钥/api-key **一律 `<redacted>`**，account/sub→前4后2掩码，email→`x***@域名`，本报告不含任何完整敏感值。

---

## 一、连通性

| 项 | 结果 |
|---|---|
| `GET /v0/management/auth-files` 自检 | ✅ **通过**，HTTP 200 |
| Tailscale / 管理密钥 | 均有效（200 即证网络通 + 鉴权过） |
| 实例现状 | auth-files **1 个号**（真实 claude 号，与用户告知一致）；usage 有大量历史事件（采样 10000 条） |

连通性通过，继续逐项核对。

---

## 二、逐项核对表

图例：✅对上 ｜ ⚠️需改/需注意 ｜ ❓未核

### ① auth-files 结构 + provider 识别 —— 对照 `normFile` [cpa.ts:257](../lib/cpa.ts) / `listAuthFiles` [cpa.ts:413]

| 子项 | 真实观测（脱敏） | 代码假设（`cpa.ts:行`） | 结论 |
|---|---|---|---|
| 顶层结构 | `{ "files": [ … ] }` | `{ files?: RawFile[] }` :414 | ✅ 对上 |
| 文件对象字段并集 | `account, account_type, auth_index, created_at, disabled, email, failed, id, label, last_refresh, modtime, name, path, provider, recent_requests, runtime_only, size, source, status, status_message, success, type, unavailable, updated_at` | — | ℹ️ 字段远比 `RawFile` 假设的丰富（多了 status/unavailable/success/failed 等健康度字段，本轮代码未用） |
| provider 识别 | 文件**同时**带 `provider:"claude"` **和** `type:"claude"`；且 `name` 前缀 `claude-` | `providerFromToken(f.provider) ?? f.type ?? name前缀` :261-262 | ✅ 对上（三条路都命中 `'claude'`→claude，最稳的显式 `provider` 字段优先） |
| 文件名模式 | `claude-<account>.json` | 代码只把前缀喂 `providerFromToken`，认 `claude`/`anthropic` :49-50 | ✅ 对上（真实前缀是 `claude-`，**不是** `anthropic-`；`providerFromToken('claude')` 已认） |
| claude 稳定 ID 字段 | **`account`**（无 `account_id`/`accountId` 字段） | `f.account_id ?? f.accountId ?? (claude? f.account)` :271-274 | ✅ 对上（前两个兜底为 undefined，正确落到 `f.account`） |
| `plan` | 文件**无** `plan`/`planType` 字段 | `f.plan ?? f.planType ?? 'unknown'` :278 | ⚠️ 轻：claude 号 auth-file 不带 plan，归一后 `plan='unknown'`（不影响唯一键/发分；若前端要显示套餐得另找来源） |

### ② usage 事件结构 —— 对照 `getDailyUsage` [cpa.ts:435-461] / `RawUsage` [cpa.ts:494]

| 子项 | 真实观测（脱敏） | 代码假设（`cpa.ts:行`） | 结论 |
|---|---|---|---|
| 顶层结构 | `{ total_requests, success_count, failure_count, total_tokens, apis }` | 取 `.apis` :441/443 | ✅ 对上（多了汇总字段，代码只读 `.apis`，无碍） |
| apis 键 | `"POST /v1/messages"`, `"POST /v1/responses"`（端点串） | `Object.values(data.apis)` 遍历值 :443 | ✅ 对上（不依赖键名） |
| models 中间层 | ✅ 存在 | `apiEntry.models[模型].details[]` :443-445 | ✅ 对上（`apis[端点].models[模型].details[]` 三层完全吻合） |
| detail 字段并集 | `timestamp, source, auth_index, api_key_hash, account_snapshot, auth_label_snapshot, auth_file_snapshot, auth_provider_snapshot, auth_snapshot_at_ms, latency_ms, ttft_ms, resolved_model, service_tier, …, tokens, failed, fail_status_code, …` | 读 `account_snapshot / auth_provider_snapshot / auth_label_snapshot / timestamp` :448-450 | ✅ **四个字段全部存在、名字完全对上** |

### ③ 稳定 ID（claude=`account`）—— 对照 [cpa.ts:449]

| 子项 | 真实观测（脱敏） | 代码假设 | 结论 |
|---|---|---|---|
| usage 稳定 ID 字段 | `account_snapshot` 存在 | `d.account_snapshot` :449 | ✅ 对上 |
| 值格式 | **邮箱形态字符串**（`localpart@域名`，实测约 14–16 字符），掩码如 `l***@***` | 当 canonical accountId 存库 | ℹ️ 注意：claude 的稳定 ID **是邮箱（含 PII）**，会作为 accountId 进 hub 库/日志——下一轮按 §8 当敏感值处理 |
| **跨端点一致性**（关键） | 当前 claude 号在 **auth-files.`account`** 与 **usage.`account_snapshot`** 里是**同一个值**（同掩码 `g***…(16)`） | settle 层按 `(provider, account_id)` 关联 | ✅ **对上——归属 join 键在两个端点一致，按量结算能正确落到该号** |
| provider 值 | `auth_provider_snapshot = "claude"` | 注释预期 `anthropic→claude` :448 | ✅ 功能对上（`providerFromToken` 同时认 `'claude'` 和 `'anthropic'`）；⚠️ **注释与实测不符**：真实值是 `"claude"` 不是 `"anthropic"`，注释可顺手更正 |

### ④ timestamp 单位（**重点**，错则按错误日聚合）—— 对照 `tsToMs` [cpa.ts:507-511]

| 子项 | 真实观测（脱敏） | 代码假设（启发式） | 结论 |
|---|---|---|---|
| `timestamp` 类型 | **ISO 8601 字符串**，如 `2026-07-16T13:53:50.795217546Z`（30 字符，纳秒精度，UTC `Z`） | 数字<1e12→秒、否则毫秒；**字符串→`Date.parse`** :508-510 | ✅ **对上**：走字符串分支，`Date.parse` 解析成功→正确 ms（纳秒小数被截到毫秒，无碍） |
| 数字秒/毫秒分支 | 未出现（claude 一律 ISO 串；另有 `auth_snapshot_at_ms`=13 位 ms，但那是快照时刻、**代码没用它**，用的是 `timestamp`） | :509 | ❓ 数字分支对 claude **不触发**（防御性保留即可，无需改） |
| 自然日换算 | timestamp 是 **UTC**；`dayStr`/`tsToMs` 落 **服务器本地时区**日 | 「时区随服务器」故意设计 :85/:134-136 | ⚠️ **需下一轮留意**：源时间是 UTC，结算按服务器本地日——生产机时区须 = 目标结算时区（与已知 CI-UTC-grace-window flaky 同源，别踩） |

### ⑤ hub label 格式（**重点**，决定谁被计费）—— 对照 `isHubContribution` [cpa.ts:497-505]

| 子项 | 真实观测（脱敏） | 代码假设 | 结论 |
|---|---|---|---|
| label 字段名 | `auth_label_snapshot` 存在 | `d.auth_label_snapshot` :447 | ✅ 对上 |
| label 真实值 | **等于该号的账号/邮箱标识**（如 `l***@***`，14–16 字符），**`containsHub=false`** | 占位注释：「label 含 `'hub'` 视为贡献号」:497 | ⚠️ **注释判据与真实数据不符**：真实 label 里**没有 `'hub'`**——它是 cpamp 自带的账号 label（=邮箱），不是 hub 注入的来源标记 |
| 实际实现行为 | — | `isHubContribution` **恒 return `true`**，放行、归属交 settle 层 pooled 索引 :504-505 | ✅ **当前实现正确**：因为放行、没真去匹配 `'hub'`，这个 claude 号能被纳入聚合 |
| 🔴 关键推论 | 若有人把预过滤"升级回"用「label 含 hub」硬闸（注释 :499-503 提到的选项） | — | ⚠️ **千万别照注释做**：真实 label `containsHub=false`，一旦按此硬过滤→这个真实贡献号被**误剔除→零发分**。当前"恒 true + 交 settle pooled 索引"是对的，须保持 |

### ⑥ /v0/management/config（只读佐证）—— 可选项

| 子项 | 真实观测（脱敏） | 佐证 | 结论 |
|---|---|---|---|
| 端点只读性 | `GET /config` 返回 200、纯读配置 | — | ✅ 只读安全 |
| 路由策略 | `routing = { strategy:"fill-first", session-affinity:true, session-affinity-ttl:"1h" }` | 佐证「路由不可选号 / 单池」假设 | ✅ 对上：`fill-first`+会话亲和＝请求由 cpamp 自动填充/粘连账号，**hub 不能指定哪个号服务某请求** |
| 其它 | `commercial-mode:true`、`usage-statistics-enabled:true`（故 `/usage` 可用）、`claude-api-key:null`（用 OAuth 号非直连 key） | — | ℹ️ 附带信息 |

---

## 三、待改 real 代码清单（汇总所有 ⚠️，供下一轮）

**核心结论：realClient 的字段假设与真实 cpamp 高度吻合，无「结构性错配」，无必须立即改的硬伤。** 下列为需处理的注释更正 + 一条"别踩"红线 + 两条轻量注意：

1. **🔴（红线，别动错）`isHubContribution` 保持恒 `true`，切勿按注释改成「label 含 hub」硬过滤。**
   真实 `auth_label_snapshot` = 账号邮箱、不含 `'hub'`（`containsHub=false`）；照注释 :497/:499-503 升级预过滤会把真实贡献号零发分。归属仍交 settle 层 `(provider, account_id)` pooled 索引。
   → 下一轮建议：**更新注释**说明真实 label 形态，并明确"hub 来源标记写入"落地前不得启用 label 预过滤；真要过滤须匹配**将来自己写入的**标记字段（非现有 `auth_label_snapshot`）。

2. **（注释更正，非逻辑）provider 值实测是 `"claude"` 不是 `"anthropic"`。** `cpa.ts:448` 注释「anthropic→claude」与实测不符（功能无碍，`providerFromToken` 两者都认）。顺手更正注释即可。

3. **（安全，轻）claude 的 accountId 是邮箱（PII）。** `account_snapshot`/`account` = 邮箱字符串，会作为 canonical accountId 进库/日志。下一轮按 §8 当敏感值对待（掩码日志、注意展示面）。

4. **（运维注意，非代码）时间戳是 UTC，结算按服务器本地日。** 生产机时区须对齐目标结算时区（与已知 CI-UTC-grace-window flaky 同源）。

5. **（可选）`plan` 对 claude 号取不到。** auth-file 无 `plan`/`planType`，归一 `plan='unknown'`。若产品要显示 claude 套餐，需另找来源；否则维持现状即可。

> 探测脚本自身的一个副产物（非 real 代码问题，**不建议改** `lib/cpa.ts`）：`scripts/probe-cpamp.ts` 里
> 高层 `cpa.listAuthFiles()`/`cpa.getDailyUsage()` 直跑抛 `Cannot find module './env'`——因 `lib/cpa.ts:3`
> 用**无扩展名** `import { env } from './env'`（Next 打包器能解析，`node` 原生 ESM 不能）。这是 Next-only
> 写法、**生产运行正常**，非 bug。本轮核对全部基于 **rawGet 的原始响应**（已足够）；高层方法产出用
> 上述原始字段**解析式推演**：两方法对真实数据均会正确跑通（provider=claude 识别成功、accountId=account
> 落值、timestamp ISO→`Date.parse` 成功、`isHubContribution` 恒 true 放行→聚合出非空按日计数）。

---

## 四、未核项清单（缺对应号 / 属写操作，留后续轮）

| 项 | 为何未核 |
|---|---|
| codex 特定字段（`id_token` 解析出的 `chatgpt_account_id`/`account_id`、`parseIdToken` :283） | 实例**无 codex 号** |
| grok 稳定 ID `sub`（OIDC subject，normFile :275） | 实例**无 grok 号** |
| codex `inspect()` 深度巡检字段（`action`/`actionReason`/`statusCode`/`errorKind`，`mapInspection` :472） | ①无 codex 号 ②`codex-inspection/run` 是 **POST**（有副作用）——🔴 只读红线内**未打** |
| usage detail 里 codex/grok 的 provider 值 & 稳定 ID 字段 | 池内只有 claude 事件，`auth_provider_snapshot` 仅见 `"claude"` |
| 优先级写入 / setDisabled / deleteAuthFile / oauth-callback 等 | 全是**写操作**——🔴 只读红线内**未打** |
| 高层 `cpa.*` 方法在真实数据上的**实跑**产出 | 直跑受 `./env` 无扩展名 import 阻断（见上）；本轮以解析式推演替代 |

---

## 五、探测方法（可复现）

```bash
# 须真实密钥（主仓 .env.local）+ Tailscale 起；SESSION_SECRET 为过 env fail-fast 的哑值（非真密钥）
MOCK=false SESSION_SECRET=probe-only-dummy-secret-0000000000000 \
  node --env-file=.env.local scripts/probe-cpamp.ts
```

- 脚本只发 GET；全部输出经 `safe()` 脱敏；`.env.local` 全局 gitignore、**未入库**。
- 本报告所有样例值均为掩码后形态，不含任何完整 account/email/token/密钥。
