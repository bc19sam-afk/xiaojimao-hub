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

> 🔴 **公网/对外部署必须 `MOCK=false`**（并配齐 `SESSION_SECRET`≥32、`CPA_BASE_URL`、`CPA_MANAGEMENT_KEY`）。`MOCK=true` 会开放**免鉴权**预览登录 `/api/auth/dev-login`、且**默认信任 `x-forwarded-*` 头**（可被伪造域名 / 开放重定向）——**仅限本机 / 内网预览**。容器启动时若非 `MOCK=false`，entrypoint 按**需求 §8 默认拒绝启动**（打印 `🛑` 并 `exit 1`）：内网/本机预览须**显式**设 `ALLOW_MOCK_PREVIEW=1` 放行（改打印 `⚠️ MOCK 预览模式` 告警后继续）。即「默认拒启 + 显式预览开关」——未声明预览的部署一律按生产对待。

---

## 2. data 卷权限（uid 1000）

容器以非 root 用户 `node`（uid **1000**）运行，需要对宿主 `./data` 有写权限。**Linux 宿主首次部署前**用一条特权命令建目录、授权、收紧权限：

```bash
sudo install -d -o 1000 -g 1000 -m 700 data   # 一步完成 建目录 + 属主 uid1000 + 权限 700：仅 owner 可进（库含 OAuth 令牌快照与 CDK 码）
```

用 `install -d` 一步到位、不拆成 `chown` + `chmod` 两步：若操作账号不是 uid1000，`sudo chown` 把 `data` 归 1000 后，紧接的**无 sudo** `chmod` 会因「非 owner 非 root 不能改权限」被拒——照两步走会卡在这。`install -d` 对已存在的目录同样适用（幂等地重设属主/权限）。

否则容器启动会因无法写 `/app/data/app.db` 而报权限错。
（macOS/Windows 的 Docker Desktop 通常自动处理 uid 映射，可跳过此步。）

> 🔒 **库文件权限**：entrypoint 里设了 `umask 077`，容器新建的 `app.db`、`-wal/-shm`、备份文件都落 **0600**（仅 owner 可读写）、目录 0700。配合上面 `install -d` 设的目录 700，同宿主的其他用户读不到库里的令牌/CDK。
> 老部署（本次升级前建的库可能是 0644）想一并收紧：umask 只管新建文件、不改既有，停服后手动 `chmod 600 data/app.db` 即可。

---

## 3. 首次部署

首次无库 → entrypoint 跳过备份、直接迁移建库。

先按目标选 `MOCK`（见 §1 红线）：

- **内网 / 本机预览**：可留 `MOCK=true`（内置模拟 CPA，无需真实网关），但须**显式**设 `ALLOW_MOCK_PREVIEW=1` 放行——否则 entrypoint 按需求 §8 默认拒启（打印 `🛑` 退出）；放行后启动日志有 `⚠️ MOCK 预览模式` 告警，属预期。
- **公网 / 生产**：**必须 `MOCK=false`**（且**别设** `ALLOW_MOCK_PREVIEW`），并在 `.env` 配齐 `SESSION_SECRET`（≥32）、`CPA_BASE_URL`、`CPA_MANAGEMENT_KEY`——否则等于对外开放免鉴权预览登录。

```bash
cp .env.example .env      # 填好 .env（见 §1）
sudo install -d -o 1000 -g 1000 -m 700 data   # Linux，见 §2（一条特权命令，别拆 chown+chmod 两步）
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

升级已由 `docker-entrypoint.sh` 落实成开机自动流程：**检测到待迁移才备份**（`schema-check` 判 schema 落后 → `node scripts/backup.ts`）→ **迁移**（`node scripts/migrate.ts`，打印 schema 版本）→ **启动**（`node server.js`）。单实例本身即锁，migrate 的 `busy_timeout` 兜住与 worker 的偶发并发。

- **只在真有迁移时才备份**：schema 已是最新（日常重启、崩溃自动重启）就不备份，免得把「迁移前那份唯一回滚点」被 `BACKUP_KEEP` 轮转挤掉。
- **未完结升级不重复备份（且防快照丢失）**：一次多迁移的升级若后段失败，库会停在中间版本、`restart:unless-stopped` 反复重启。入口用 `data/.upgrade-in-progress` 标记去重，备份后**把升级前快照钉成 `data/backups/preupgrade.db`**（改名移出 `backup-*.db` 轮转集——`lib/backup.ts` 轮转只认 `^backup-.*\.db$`，故 `BACKUP_KEEP` 与手动 `backup.ts` 都不会把它转掉），**标记内容记的就是这份 `preupgrade.db` 的绝对路径**：重试时先验证该快照仍在——**在就跳过备份**、沿用它作回滚点（未完结的升级链哪怕中途换目标版本，如原目标 v12 卡住、又部署 v13 的新镜像，也共享这同一份「原始升级前」快照）；**快照已丢**（`BACKUP_DIR` 被改到非持久路径、或快照被删）**则重新备份当前状态**（有回滚点总比裸迁移强）。迁移成功即删标记、升级闭环（`preupgrade.db` 作无害冗余留着，至多一份，下次升级 `mv` 覆盖）。这样崩溃循环 / 跨目标重试 / 升级卡住期间手动备份，既不会用中间态备份 + `BACKUP_KEEP` 轮转挤掉唯一的「升级前」回滚点，也不会在快照丢失时没回滚点就裸跑迁移。
- **备份 fail-closed**：备份失败即**中止启动**（不迁移、不起服务），保住回滚点；日志停在备份报错处，容器进入重启循环。

```bash
git pull                     # 或换用新镜像 tag
docker compose up -d --build # 重建镜像并滚动重启；入口自动 备份→迁移→启动
docker compose logs -f app   # 有迁移：[schema-check] 需迁移 → [backup] 完成 → [migrate] 完成 → 服务起
                             # 无迁移：[schema-check] 已最新，跳过备份 → [migrate] 完成 → 服务起
                             # 迁移重试：[entrypoint] 上次升级…未完结…跳过备份 → [migrate] 完成 → 服务起
```

> **备份失败 = 启动中止**（fail-closed 的预期副作用，不是 bug）：日志卡在 `[backup]` 报错、容器反复重启。先修根因——通常是 `./data` 磁盘满或权限不对（见 §2）；修好后 `docker compose up -d` 重试即可（幂等，会重走「备份→迁移→启动」）。**极端破窗**：确已另行留好快照、明知无需入口那份回滚点，要强行跳过备份启动，可临时覆盖入口进容器手动跑：
>
> ```bash
> docker compose stop app     # 必须先停：① app 仍在 restart 循环占着 127.0.0.1:3000，--service-ports 会撞端口；
>                             #          ② 不停就是两容器共享同一 SQLite 卷，违反 §0 单实例红线
> docker compose run --rm --service-ports --entrypoint sh app
> # 进容器后：node scripts/migrate.ts && exec node server.js
> ```
>
> 破窗操作请清楚自己在做什么再用。

> 升级前如需人工快照，见 §5 手动备份。回滚：停容器 → 用 §5 的恢复步骤还原到升级前的备份 → 起旧镜像。

---

## 5. 备份与恢复

### 5.1 备份机制

`scripts/backup.ts` 用 SQLite `VACUUM INTO` 产出 **WAL 安全的一致性单文件快照**（对源库只读、不打断在线写入），落到 `data/backups/backup-<时间戳>-<随机>.db`，并按 `BACKUP_KEEP`（默认 7）只保留最新 N 份。

- 自动：容器启动时若 `schema-check` 判定**有待迁移**才备份（schema 已最新则跳过）；未完结升级的重试（含中途换目标版本）由 `.upgrade-in-progress` 标记去重，标记记录升级前快照（备份后钉成 `data/backups/preupgrade.db`、改名移出 `backup-*.db` 轮转集，不被 `BACKUP_KEEP`/手动备份轮转掉）的绝对路径、**验证快照仍在才跳过备份**（快照丢失则重新备份当前状态），保住迁移前唯一回滚点，迁移成功即清标记；备份失败即中止启动（fail-closed）。详见 §4。
- 手动随时触发：

  ```bash
  docker compose exec app node scripts/backup.ts
  ls -la data/backups/
  ```

### 5.2 恢复演练（务必在上线前演练一次）

快照是完整一致的库文件，恢复即「用某份快照替换 app.db」。演练步骤：

> 操作账号非 uid1000 时，下面直接读写 `./data`（0700，属主 1000）的命令都需 `sudo`；还原用 `install` 一步把 `app.db` 设成 **属主 1000 + 权限 600**（`cp` 覆盖已存在文件会保留目标原 mode，老部署那份 0644 不会收敛，且属主也要还原），否则容器起来写不了库、或库权限倒退到 0644。

```bash
# 1) 先做一次备份，拿到一份快照文件名
docker compose exec app node scripts/backup.ts
sudo ls data/backups/                # 记下 backup-XXXX.db

# 2) 停服务（释放对 app.db 的写锁）
docker compose stop app

# 3) 备份现场后替换（-wal/-shm 是 WAL 副本，恢复整库快照时必须一并删除；
#    .upgrade-in-progress 也要清——手动还原=人为终结升级链，不清则下次真升级会因「标记指向的旧快照仍在」被误判、跳过备份）
sudo cp data/app.db data/app.db.broken.bak 2>/dev/null || true
# 还原源：日常回滚用某份 backup-XXXX.db；若还原的是「升级失败现场」，升级前快照就是 data/backups/preupgrade.db（钉住不轮转、即最近一次升级前的库）
sudo install -o 1000 -g 1000 -m 600 data/backups/backup-XXXX.db data/app.db   # 一步 覆盖还原 + 属主 uid1000 + 权限 600；不用 cp（覆盖会保留目标原 mode，老部署 0644 收不紧、属主也不还原）
sudo rm -f data/app.db-wal data/app.db-shm
sudo rm -f data/.upgrade-in-progress

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
        proxy_set_header   X-Forwarded-Host  hub.example.com;   # 钉死你的域名，别用 $host（默认/唯一 server 下 $host 兜底取客户端 Host 头，伪造照样透传）；TRUST_FORWARDED_HEADERS=true 时据此推断域名，见 §6.2
    }
}
# 80 端口重定向到 443（略）
```

### 6.2 域名与 env 对齐

- 把 `.env` 的 `APP_BASE_URL` 设为公网 HTTPS 地址，例如 `https://hub.example.com`。
- 若信任并已在反代**覆盖/清洗**了 `x-forwarded-*` 头，可设 `TRUST_FORWARDED_HEADERS=true`；否则保持 false，固定用 `APP_BASE_URL` 推断 origin（防开放重定向）。
  - ⚠️ 设 `true` 的**前提**：反代必须把 `X-Forwarded-Host` **覆写为固定域名**（`proxy_set_header X-Forwarded-Host hub.example.com;`，见 §6.1）——**别用 `$host`**：默认/唯一 server 块下 `$host` 会兜底取客户端 Host 头，伪造值照样透传。`originOf()`（`lib/request.ts`）采信该头拼 origin，用于登录/OAuth 回调等重定向——一旦放行伪造值就是**开放重定向**（把用户导向攻击者域名）。nginx 默认不会自动覆盖它：不显式 `proxy_set_header` 就会把客户端原值透传上游。

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
