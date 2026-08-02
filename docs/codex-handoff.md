# 小鸡毛账号收集系统 Codex 交接手册

## 1. 交接结论

截至 2026-08-02，项目源码与框架已经完成发布硬化，可以交给新的维护者或其 Codex 继续做 Linux.do、CPA、积分参数和目标服务器配置。

这不代表系统已经在接手方生产环境验收。真实凭据、真实账号、目标服务器与域名均不在仓库中，也不应被加入仓库。

GitHub Admin 权限只提供仓库管理与编辑能力，不会附带任何旧测试 CPA、Linux.do 应用、Plus/分享账号、服务器或凭据。以前用于验证的外部资源被有意排除在交付物之外；接手方必须使用自己的 Linux.do、CPA、账号与目标服务器配置。

## 2. 可复现发布基线

| 项目 | 状态 |
| --- | --- |
| Repository | `bc19sam-afk/xiaojimao-hub` |
| 已验收应用基线 | `03907752904cc1c3b4585a899cc7e2375f2d4215` |
| 发布硬化 PR | [#38](https://github.com/bc19sam-afk/xiaojimao-hub/pull/38) `MERGED` |
| 后台 UI PR | [#39](https://github.com/bc19sam-afk/xiaojimao-hub/pull/39) `MERGED` |
| `main` CI | [30734009302](https://github.com/bc19sam-afk/xiaojimao-hub/actions/runs/30734009302) `SUCCESS` |
| 独立复审 | exact SHA clean-room `APPROVE` |

合并态 CI 证据：

- Next production build：`38/38` routes。
- Node tests：`649/649`，0 failures。
- Chromium E2E：`19/19`。
- Real restore validator：`27/27`。
- Linux hidepid：`1/1`。
- `npm audit --omit=dev`：0 vulnerabilities。
- Linux arm64 production Docker/Sharp PNG smoke 已通过。

上述 SHA 是交接时的历史锚点。新的 Codex 开始工作时应重新读取 GitHub，而不是假设它仍是最新提交。

## 3. 产品与拓扑边界

本项目只负责：

- Linux.do 登录与贡献者身份。
- Codex、Claude、Grok 账号贡献。
- CPA 首检、入池、存活巡检。
- 按日 usage 结算与积分账本。
- CDK/LDC 积分商店。
- 管理后台、审计、备份恢复与运行监控。

CPA 号池的长期管理、调度与 CPAMP 架构不属于本项目。

首版生产拓扑固定为：

```text
单台服务器
└── 单个 Next.js 容器 / 实例
    ├── 单个 SQLite 持久化卷
    ├── 单个后台 worker
    └── 唯一的 CPA auth-files 写入口
```

不要在未重新设计并评审前运行多实例、共享 SQLite、多 worker 或多个 auth-file 生产者。

## 4. 已关闭的发布风险

PR #38 已完成以下关键修复：

- OAuth session 绑定 Linux.do user、provider、state 与 expiry。
- provider lease、operation fencing、hard expiry 与 late-result CAS。
- OAuth/RT auth-file 写入串行化；多候选与未知上传结果 fail closed。
- CPA inspection envelope/row、auth-file row 与 ID-token identity 严格运行时解析。
- provider 切换后隐藏旧 session，并阻止旧 provider 的 check/cancel/finish。
- OAuth、RT、`verify-now` 的 exact same-origin 与 JSON mutation guard。
- 外部请求统一 timeout、响应边界和错误脱敏。
- 普通用户不能调用全局 `verify-now`。
- non-MOCK worker 默认 5 分钟，危险小间隔 fail fast。
- 生产依赖、Linux arm64 Sharp、备份 restore/hidepid 安全门已验证。

不要为了“简化”而移除这些 fail-closed parser、lease 字段、CAS 检查、origin guard 或零副作用测试。

## 5. 接手方需要自行提供的配置

以 [`.env.example`](../.env.example) 为唯一变量清单，不要从聊天记录复制旧值。

不要搜索 Git 历史、旧 worktree 或工具缓存来恢复之前的测试配置；它们不属于接手方授权范围，也不应成为生产依赖。

必须由接手方在目标环境填写或确认：

- `APP_BASE_URL`：最终 HTTPS 地址。
- `SESSION_SECRET`：至少 32 字符的强随机值。
- `LINUXDO_CLIENT_ID` / `LINUXDO_CLIENT_SECRET`。
- Linux.do OAuth callback：`${APP_BASE_URL}/api/auth/linuxdo/callback`，必须逐字匹配。
- `ADMIN_PASSWORD` 或 `ADMIN_LINUXDO_IDS`。
- `MIN_TRUST_LEVEL`。
- `MOCK=false`；生产环境不要设置 `ALLOW_MOCK_PREVIEW`。
- `CPA_BASE_URL` / `CPA_MANAGEMENT_KEY`。
- 积分费率、入池优先级、grace、商品、限购、CDK/LDC 库存。
- `HEARTBEAT_URL`、备份保留与异机同步目标。

`.env` 必须为 `0600`，不得进入 Git、Docker image、PR、Codex 对话或日志。

## 6. 新 Codex 的接手步骤

### 第一步：证明仓库身份

```bash
git remote -v
git fetch --prune origin
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
gh repo view --json nameWithOwner,defaultBranchRef
```

若本地有未跟踪或已修改文件，不要 reset、clean 或 stash；先判断所有权与范围。

### 第二步：建立环境上下文

依次阅读：

1. `AGENTS.md`
2. `需求文档.md`
3. `README.md`
4. `docs/deploy.md`
5. `docs/release-checklist.md`
6. `.env.example`

### 第三步：离线验证

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
npm run test:ui -- --project=chromium
npm run test:restore-real
npm audit --omit=dev
```

若代码未变化，可复用仍然匹配 exact SHA 的 CI 作为基础证据，但目标机的 Docker、存储权限和网络仍需重新验证。

### 第四步：目标机预检

- 域名、DNS、TLS 自动续期与 nginx 固定域名配置。
- Docker Compose v2、持久化 `data/`、uid 1000 写权限、磁盘余量与日志轮转。
- 单实例、单 worker、唯一 CPA auth-file 写者。
- CPA 地址从容器网络命名空间可达。
- `/api/health`、`/api/ready` 与 dead-man heartbeat 可观测。
- 异机备份目标已建立。

严格按 [`docs/deploy.md`](deploy.md) 操作，不从记忆拼装部署命令。

## 7. 真实外部验收

以下项目必须在接手方环境完成，不能用 MOCK 或旧账号测试替代：

1. Linux.do 真实登录和退出。
2. 一次性测试目标上的 CPA 写链，包括 `setPriority`，结束后恢复原状态。
3. 一个明确授权真号的“提交 → 首检 → 入池 → usage → 积分”E2E。
4. 目标服务器上的受控 restore 演练，并记录恢复耗时。
5. 部署后观察日志、ready、worker 心跳、备份、首检积压与积分流水至少一个完整 worker/结算窗口。

真实写测试开始前必须记录：

- exact 目标和身份指纹。
- 允许的方法与请求体。
- 原始状态 readback。
- 预期副作用。
- 清理与恢复步骤。

目标、响应或状态发生漂移时立即停止，不扩大测试范围。

## 8. 交付判定

可以说：

> 源码/框架已合并到 `main`，通过独立复审与合并态 CI，可进入接手方环境配置和真实外部验收。

在第 7 节全部完成前，不可以说：

> 已经生产上线、真实 CPA 已验收、真实 Linux.do/账号全链路已确认。

## 9. 本地工具残留

历史工作区可能存在 `.codegraph/`、`.hallmark/` 或旧 worktree。它们不是产品源码：

- 不要提交。
- 不要因为“清洁工作树”而擅自删除。
- 不要从旧 worktree 的 HEAD 推断当前 GitHub 状态。

最终结论始终以当前仓库、`origin/main`、PR exact HEAD 和对应 CI `headSha` 为准。
