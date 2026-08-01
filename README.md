# 小鸡毛账号收集系统（Hub）

用 Linux.do OAuth 作为身份入口：贡献者提交 Codex / Claude / Grok 账号，账号进入 CPA（CLIProxyAPI / cpamp）号池，系统按每日实际调用量折算积分，再用积分兑换 CDK / LDC。

## 产品边界

- 本站只负责**贡献台 + 按日结算 + 积分商店**。
- CPA 号池的长期管理与调度属于独立系统，不在本项目内重复实现。
- 首版部署形态锁定为**单机、单实例、SQLite 持久化卷、单 worker**。

完整规则见 [`需求文档.md`](./需求文档.md)，实施记录见 [`实现路线图.md`](./实现路线图.md)。

## 架构

```text
浏览器 ── Linux.do 登录 ──▶ Next.js 应用 ──▶ SQLite
                             │
                             ├─ 授权 / RT 收号 ──▶ CPA 管理 API
                             ├─ worker：首检 → 入池 → 存活巡检
                             ├─ worker：每日用量 → 幂等结算 → 积分账本
                             └─ 积分商店：CDK / LDC 库存与兑换
```

## 当前进度

- **P0–P5 已合并收官**：身份、收号、首检入池、按日计量发分、Dashboard、排行榜、CDK/LDC 商店、后台配置、审计与人工复核已完成。
- **P6-R1 + P6-R2 已合并**：Docker / Compose、非 root 运行、持久化卷、迁移前备份、readiness + DB 探活、每日备份、异机同步、WAL 安全恢复脚本与 dead-man 心跳均已完成并通过真实 Docker/Linux 验证。
- **UI-R1 已合并**：后台危险操作确认、移动端表格边界、兑换状态、readiness 无业务副作用和首次 DB replacement fail-closed 已收口。
- **P7-R1 已合并**：usage payload 严格校验与累计结算 reconciliation 已落地；partial → full 只补正差额，同值幂等、低值不倒扣，未修改 CPAMP、未新增 migration。
- **MOCK 全链路可验证**：交号 → 首检 → 入池 → 每日用量 → 积分 → 兑换。
- **当前为 release candidate，不等于已上线**：`main` 已通过合并态 CI；仍未完成真实 Linux.do + 真号 E2E、CPA 写操作实测和真实服务器部署。这些外部验收须单独授权，不能从本地/CI 结果自动外推。

> 截至 2026-07-31，远端 `main` 为 `ae41555`（合并 PR #36），合并态 CI run `30639486006` 成功。请勿把“本地 MOCK 可运行”、“Docker/CI 已验证”与“生产已验收”视为同一状态。

## 本地 MOCK 运行

```bash
npm install
[ -f .env.local ] || install -m 600 .env.example .env.local
npm run dev
```

- `.env.example` 默认 `MOCK=true`，本地开发会自动迁移 SQLite，无需真实 CPA 密钥。
- 未配 Linux.do OAuth 时，可使用本地预览登录；该模式仅限本机或内网。
- 默认访问地址：`http://localhost:3000`。

## 验证

```bash
npm test
npm run build
node --env-file=.env.local scripts/schema-check.ts
```

## Docker 部署

按 [`docs/deploy.md`](./docs/deploy.md) 准备权限为 `0600` 的 `.env`、`data` 持久化目录、HTTPS 反向代理和备份/恢复流程。公网或对外部署必须显式设置 `MOCK=false` 并配齐生产密钥。
