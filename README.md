# 小鸡毛账号收集系统（Hub）

对标 `hub.icoe.pp.ua`：用 Linux.do OAuth 做身份闸门，让用户授权贡献 Codex 账号，账号自动进 CPA（CLIProxyAPI）账号池，健康通过后发放公益站额度，形成自循环。

## 架构

```
浏览器 ── Linux.do 登录 ──▶ Next.js 应用 ── Bearer 管理密钥 ──▶ CPA 网关(CLIProxyAPI)
                             ├ /api/auth/linuxdo/*   身份闸门
                             ├ /dashboard            授权收号 + 额度
                             ├ /api/codex/oauth/*    (P1) 走 CPA 网页 OAuth 收号
                             └ worker                (P2) 健康校验→启用→发额度
```

## 当前进度

- **P0（已完成）**：Next.js 骨架 + Linux.do OAuth 登录 + JWT 会话 + 登录/看板页。
- P1：dashboard + Codex OAuth 收号（照抄参考站并做得更好看）。
- P2：健康校验 → 启用 → 发额度 → 通知。
- P3：防刷 + 管理后台 + 部署。

## 本地运行

```bash
npm install
cp .env.example .env.local   # 填 LINUXDO_CLIENT_ID/SECRET、SESSION_SECRET
npm run dev                  # http://localhost:3000
```

`.env` 未填 Linux.do 时应用照常启动，只是点登录会跳回 `/login?error=config`。

## 需要补的配置

| 变量 | 用途 | 阶段 |
|---|---|---|
| `LINUXDO_CLIENT_ID` / `SECRET` | Linux.do OAuth 应用（回调填 `<APP_BASE_URL>/api/auth/linuxdo/callback`） | P0 |
| `SESSION_SECRET` | 会话签名，`openssl rand -hex 32` | P0 |
| `MIN_TRUST_LEVEL` | 最低信任等级门槛，防小号 | P0 |
| `CPA_BASE_URL` / `CPA_MANAGEMENT_KEY` | CPA 网关地址与管理密钥 | P1 |
