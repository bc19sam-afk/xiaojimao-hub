# 小鸡毛账号收集系统：Codex 协作入口

本文件是仓库级 Codex 入口。接手本项目时，先阅读：

1. [`docs/codex-handoff.md`](docs/codex-handoff.md) —— 当前交付状态、外部验收与安全边界。
2. [`README.md`](README.md) —— 产品边界、架构与常用命令。
3. [`需求文档.md`](需求文档.md) —— 已锁定的产品规则，不能用临时想法覆盖。
4. [`docs/deploy.md`](docs/deploy.md) 与 [`docs/release-checklist.md`](docs/release-checklist.md) —— 单机部署、备份恢复和上线门禁。

## 当前发布基线

- 仓库：`bc19sam-afk/xiaojimao-hub`
- 2026-08-02 已交付源码基线：`03907752904cc1c3b4585a899cc7e2375f2d4215`
- 发布硬化：PR [#38](https://github.com/bc19sam-afk/xiaojimao-hub/pull/38)
- 后台 UI 增量：PR [#39](https://github.com/bc19sam-afk/xiaojimao-hub/pull/39)
- 合并态 CI：[30734009302](https://github.com/bc19sam-afk/xiaojimao-hub/actions/runs/30734009302)
- 独立 clean-room reviewer 已对该 SHA 给出 `APPROVE`。

这是历史基线，不是永远固定的 HEAD。开始工作时必须重新核对 `origin/main`、当前 PR 和 exact-head CI；若 GitHub 已前进，以实时状态为准。

## 已完成与未完成

- 已完成：贡献台、Linux.do 身份入口、Codex/Claude/Grok 收号、CPA 首检入池、每日使用量结算、积分账本、CDK/LDC 商店、后台、Docker/Compose、备份恢复、release hardening 与后台响应式 UI。
- 已证明：build `38/38`、Node `649/649`、Chromium `19/19`、restore `27/27`、hidepid `1/1`，production 依赖审计为 0 vulnerabilities。
- 未完成：目标服务器部署、真实 Linux.do 应用配置、真实 CPA 写链、授权真号 E2E、目标机 restore 演练及部署后观察。
- 因此只能说“源码/框架可交付”，不能说“生产已验收”。
- GitHub Admin 权限只代表仓库编辑权限，不代表获得任何旧测试 CPA、Linux.do 应用、测试账号、服务器或凭据；接手方应接入自己的环境。

## 不可突破的边界

- 不把任何 `.env`、OAuth secret、CPA key、账号、cookie、token 或私钥写入 Git、PR、日志和文档。
- 不尝试从 Git 历史、旧 worktree 或本地工具缓存恢复以前的测试账号/CPA/服务器信息。
- 未获得当次明确授权时，不做部署、生产操作、真实 Linux.do/OAuth、真实 CPA 写入或账号测试。
- 真实写测试必须锁定 exact 目标、方法、预期副作用、原始状态与恢复步骤；发生漂移立即停止。
- 首版拓扑锁定为单机、单实例、SQLite 持久化卷、单 worker。不要擅自扩成多实例或 PostgreSQL。
- CPA `auth-files` 在本服务运行期间必须保持单写者；不要同时用其它 UI、脚本或客户端创建 auth file。
- P7 只做 usage row 数量与增长监控；不要顺手扩展 CPAMP、P7 分页或池管理架构。
- 公网环境必须 `MOCK=false`；`MOCK=true` 与 `ALLOW_MOCK_PREVIEW=1` 仅限本机或内网预览。
- 不 force push、不 rebase 共享分支、不清理或覆盖用户工作。看到脏 worktree 先审计完整 diff。
- `.codegraph/`、`.hallmark/` 等本地工具目录不是产品文件，不要提交或删除。

## 推荐工作流

1. `git fetch --prune origin`，核对 branch、HEAD、remote、PR 和 CI。
2. 先运行 `git status --short --branch`；不得用 reset/clean/stash 隐藏现有工作。
3. 从最新 `main` 创建 `codex/<主题>` 分支，保持 diff 小且单一。
4. 逻辑修复需要 RED → GREEN、零副作用/Mutation 证据；文档变更至少运行 `git diff --check` 和敏感信息检查。
5. 常规验证：
   - `npm test`
   - `npx tsc --noEmit`
   - `npm run build`
   - `npm run test:ui -- --project=chromium`
   - 发布/恢复相关改动再运行 `npm run test:restore-real`
6. 推送后使用 Draft PR，确认 local HEAD、remote branch、PR head、CI `headSha` 完全一致。
7. CI 或 MOCK 绿灯不能代替真实外部验收；交付报告必须把两者分开。

## 关键实现位置

- 收号与状态机：`lib/collect.ts`、`lib/cpa.ts`、`lib/db.ts`
- OAuth 协议与请求门禁：`lib/oauth-protocol.ts`、`lib/oauth-route.ts`
- 外部请求边界：`lib/outbound-http.ts`、`lib/linuxdo.ts`
- 前台收号：`components/CollectPanel.tsx`
- 后台：`components/admin/AdminPanel.tsx`
- 数据迁移：`lib/migrate.ts`、`scripts/migrate.ts`
- 生产部署与恢复：`Dockerfile`、`docker-compose.yml`、`scripts/restore.sh`、`docs/deploy.md`

任何新的结论都应附 exact SHA、实际测试输出和外部操作边界，不要仅凭旧 handoff 或旧 CI 推断当前状态。
