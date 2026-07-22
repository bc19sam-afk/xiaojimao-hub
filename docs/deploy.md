# 部署运维手册（P6-R1）

「小鸡毛账号收集系统」xiaojimao-hub 的单机 Docker 部署与日常运维。

---

## 0. 部署模型与红线

- **单机 · 单实例 · SQLite · 单 worker**。这是定死的模型，别改。
- 🔴 **单实例红线**：绝不 `replicas>1`、绝不多容器共享 `./data` 卷。SQLite 是单写模型，多个写入者会腐坏库。要横向扩容得先换 PostgreSQL + 独立锁 worker——本轮不做。
- 🔴 **密钥不入库/不进镜像**：`.env`/`.env.local` 含真实密钥，由 `.gitignore` + `.dockerignore` 双拦。镜像里绝不烘 `data/app.db`。
- worker 依赖**常驻 Node 进程**：`instrumentation.ts` 在服务启动时拉起 `lib/worker.ts` 的后台巡检（首检/存活/结算）。serverless 不适用。

组件一览：

| 项 | 值 |
|---|---|
| 运行时 | `node:26-alpine`，Next.js standalone（`node server.js`） |
| 监听 | 容器内 `0.0.0.0:3000`；compose 只映射到宿主 `127.0.0.1:3000` |
| 持久化 | 宿主 `./data` → 容器 `/app/data`（库 `app.db` + 备份 `backups/`） |
| 时区 | `TZ=Asia/Shanghai`（镜像装了 tzdata，compose 已设） |
| 健康检查 | `GET /api/health` → `{"ok":true}`（无鉴权、无信息泄露） |
| 运行用户 | 非 root，`node`（uid 1000） |

---

## 1. 前置条件

- 宿主装好 Docker（本手册按 Docker Compose v2，命令 `docker compose`）。
- 准备 `.env`：

  ```bash
  cp .env.example .env
  # 按需填：SESSION_SECRET（生产必填，见下）、ADMIN_PASSWORD 或 ADMIN_LINUXDO_IDS、
  # LINUXDO_CLIENT_ID/SECRET、以及切真实时的 MOCK=false + CPA_BASE_URL/CPA_MANAGEMENT_KEY
  ```

- 生成会话密钥（非 MOCK 环境缺失/过短会 fail-fast 拒启）：

  ```bash
  openssl rand -hex 32
  ```

- `.env.example` 是配置的**权威清单**：代码引用的每个 env 变量都登记在册，含注释与安全默认。

---

## 2. data 卷权限（uid 1000）

容器以非 root 用户 `node`（uid **1000**）运行，需要对宿主 `./data` 有写权限。**Linux 宿主首次部署前**先建目录并授权：

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

否则容器启动会因无法写 `/app/data/app.db` 而报权限错。
（macOS/Windows 的 Docker Desktop 通常自动处理 uid 映射，可跳过 chown。）

---

## 3. 首次部署

首次无库 → entrypoint 跳过备份、直接迁移建库。

```bash
cp .env.example .env      # 填好 .env（见 §1）
mkdir -p data && sudo chown -R 1000:1000 data   # Linux，见 §2
docker compose up -d --build
```

验证：

```bash
docker compose logs -f app          # 应见 [migrate] 完成 + [worker] 后台巡检已启动
curl -s http://127.0.0.1:3000/api/health   # → {"ok":true}
ls -la data/                         # app.db 已生成，落在宿主卷里
```

---

## 4. 升级流程（备份 → 迁移 → 校验 → 启动）

升级已由 `docker-entrypoint.sh` 落实成开机自动流程：**有库先备份**（`node scripts/backup.ts`）→ **迁移**（`node scripts/migrate.ts`，打印 schema 版本）→ **启动**（`node server.js`）。单实例本身即锁，migrate 的 `busy_timeout` 兜住与 worker 的偶发并发。

```bash
git pull                     # 或换用新镜像 tag
docker compose up -d --build # 重建镜像并滚动重启；入口自动 备份→迁移→启动
docker compose logs -f app   # 确认见 [backup] 完成（有库）→ [migrate] 完成 → 服务起
```

> 升级前如需人工快照，见 §5 手动备份。回滚：停容器 → 用 §5 的恢复步骤还原到升级前的备份 → 起旧镜像。

---

## 5. 备份与恢复

### 5.1 备份机制

`scripts/backup.ts` 用 SQLite `VACUUM INTO` 产出 **WAL 安全的一致性单文件快照**（对源库只读、不打断在线写入），落到 `data/backups/backup-<时间戳>-<随机>.db`，并按 `BACKUP_KEEP`（默认 7）只保留最新 N 份。

- 自动：每次容器启动（升级）时，若已有库则先备份（见 §4）。
- 手动随时触发：

  ```bash
  docker compose exec app node scripts/backup.ts
  ls -la data/backups/
  ```

### 5.2 恢复演练（务必在上线前演练一次）

快照是完整一致的库文件，恢复即「用某份快照替换 app.db」。演练步骤：

```bash
# 1) 先做一次备份，拿到一份快照文件名
docker compose exec app node scripts/backup.ts
ls data/backups/                     # 记下 backup-XXXX.db

# 2) 停服务（释放对 app.db 的写锁）
docker compose stop app

# 3) 备份现场后替换（-wal/-shm 是 WAL 副本，恢复整库快照时必须一并删除）
cp data/app.db data/app.db.broken.bak 2>/dev/null || true
cp data/backups/backup-XXXX.db data/app.db
rm -f data/app.db-wal data/app.db-shm

# 4) 起服务，校验
docker compose start app
docker compose logs -f app           # [migrate] 完成、schema 版本正常
curl -s http://127.0.0.1:3000/api/health   # {"ok":true}
```

数据核对无误后删掉 `data/app.db.broken.bak`。

> 异地/离线备份自动化、恢复脚本化留 R2；当前请把 `data/backups/` 纳入宿主机的常规异地备份。

---

## 6. 前置反代与 HTTPS

容器只监听宿主 `127.0.0.1:3000`，**不直接对公网**。TLS 由前置反代（nginx/Caddy）终结后转发。

### 6.1 nginx 示例

```nginx
server {
    listen 443 ssl http2;
    server_name hub.example.com;        # ← 你的域名

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
# 80 端口重定向到 443（略）
```

### 6.2 域名与 env 对齐

- 把 `.env` 的 `APP_BASE_URL` 设为公网 HTTPS 地址，例如 `https://hub.example.com`。
- 若信任并已在反代清洗了 `x-forwarded-*` 头，可设 `TRUST_FORWARDED_HEADERS=true`；否则保持 false，固定用 `APP_BASE_URL` 推断 origin（防开放重定向）。

### 6.3 Linux.do OAuth 回调

回调地址由 `APP_BASE_URL` 拼成：

```
${APP_BASE_URL}/api/auth/linuxdo/callback
```

例如 `https://hub.example.com/api/auth/linuxdo/callback`。**必须**在 Linux.do OAuth 应用后台把这个 URL 登记为允许的回调地址，且与 `APP_BASE_URL` 完全一致，否则登录会被拒。

---

## 7. TZ 结算对齐（关键）

结算逻辑按**服务器本地日**折算每日用量（`lib/settle.ts`）。容器默认时区是 UTC，会把「日」的边界切错——凌晨 0–8 点（东八区）的调用可能被算到前一天，正是 CI 里那个 `UTC 00:00–00:10` grace 窗口 flaky 的生产版。

因此：

- 镜像已 `apk add tzdata`，`docker-compose.yml` 已设 `TZ=Asia/Shanghai`。
- 非 Docker 部署（本轮不覆盖）也务必让进程时区为 `Asia/Shanghai`。
- 换服务器/机房后，确认容器内 `date` 显示的是东八区时间：

  ```bash
  docker compose exec app date   # 应为 CST，不是 UTC
  ```

---

## 8. 容器访问 cpamp（真实模式）

切真实（`MOCK=false`）时，容器需能连到 cpamp 网关。核心要求只有一个：**`CPA_BASE_URL` 在容器网络命名空间内可达**。

- cpamp 在**另一台主机/公网**：`CPA_BASE_URL` 填其可达地址即可，无需额外配置。
- cpamp 在**同一宿主机**上：容器的 `localhost` 不是宿主的 localhost。可用 `host.docker.internal` 指向宿主；Linux 上需在 compose 里加 `extra_hosts: ["host.docker.internal:host-gateway"]`，或把两者放进同一 docker network 用服务名互访。

```yaml
# 示例（占位）：cpamp 跑在宿主上时，让容器经 host-gateway 访问
# extra_hosts:
#   - "host.docker.internal:host-gateway"
# 然后 .env: CPA_BASE_URL=http://host.docker.internal:<cpamp端口>
```

> 以上为示例/占位。真实网络方案（专网/内网互通/鉴权）与真号 E2E 留 **对接-R3**，届时涉及真实实例写操作需另行授权，本轮全程 MOCK。

---

## 9. 健康检查与故障排查

- **存活探针**：`GET /api/health` → `{"ok":true}`，无鉴权、无副作用、不泄露版本/配置/账号。镜像内置 `HEALTHCHECK`（用 Node fetch，alpine 无 curl），`docker ps` 的 `STATUS` 列会显示 healthy/unhealthy。readiness + DB 探活留 R2。
- **看日志**：`docker compose logs -f app`。关键行：`[migrate] 完成`、`[worker] 后台巡检已启动`、`[backup] 完成`。
- **确认非 root**：`docker compose exec app id` → `uid=1000`。
- **确认库落卷**：宿主 `ls -la data/`，删容器重建后 `app.db` 仍在即为持久成功。
- **日志轮转**：compose 已配 json-file `max-size=10m`、`max-file=5`，防磁盘被撑爆。

---

## 附：常用命令

```bash
docker compose up -d --build        # 部署/升级
docker compose logs -f app          # 跟随日志
docker compose exec app node scripts/backup.ts   # 手动备份
docker compose exec app date        # 核对时区
docker compose exec app id          # 核对非 root
docker compose down                 # 停并删容器（保留宿主 ./data）
```
