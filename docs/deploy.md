# 部署运维手册（P6-R1）

「小鸡毛账号收集系统」xiaojimao-hub 的单机 Docker 部署与日常运维。

---

## 0. 部署模型与红线

- **单机 · 单实例 · SQLite · 单 worker**。这是定死的模型，别改。
- 🔴 **单实例红线**：绝不 `replicas>1`、绝不多容器共享 `./data` 卷。SQLite 是单写模型，多个写入者会腐坏库。要横向扩容得先换 PostgreSQL + 独立锁 worker——本轮不做。
- Compose 默认项目名为 `xiaojimao-hub`（解决中文目录推导名为空），但 `-p` / `COMPOSE_PROJECT_NAME` 优先级更高。
  **同一宿主默认只跑一套本系统**；若确需预演/第二 checkout，必须全程用独立项目名（如
  `docker compose -p xiaojimao-hub-staging ...`）并隔离端口与数据目录。历史上若用过 `-p OLD_NAME`，升级/回滚须继续带旧名，
  确认旧栈已停止并移交数据后再切换，避免同宿主留下两套资源。
  如旧部署从未显式设 `-p`、而是依赖旧目录名推导出其他项目名，先用该旧名显式操作完停栈/数据移交，再切到默认名。
- 🔴 **密钥不入库/不进镜像**：`.env`/`.env.local` 含真实密钥，由 `.gitignore` + `.dockerignore` 双拦。镜像里绝不烘 `data/app.db`。
- worker 依赖**常驻 Node 进程**：`instrumentation.ts` 在服务启动时拉起 `lib/worker.ts` 的后台巡检（首检/存活/结算）。serverless 不适用。

组件一览：

| 项 | 值 |
|---|---|
| Compose 默认项目名 | `xiaojimao-hub`（已在 `docker-compose.yml` 设默认；`-p` / `COMPOSE_PROJECT_NAME` 可显式覆盖） |
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
  [ -f .env ] || install -m 600 .env.example .env   # 已存在则跳过：避免误重跑把已配好的密钥清空。install 而非 cp（cp 受宿主 umask 022 落 0644，.env 存密钥须 600·仅属主可读；install 直接 600、普通用户可跑无需 sudo）；老 .env 想收权限手动 chmod 600 .env
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

用 `install -d` 一步到位、不拆成 `chown` + `chmod` 两步：若操作账号不是 uid1000，`sudo chown` 把 `data` 归 1000 后，紧接的**无 sudo** `chmod` 会因「非 owner 非 root 不能改权限」被拒——照两步走会卡在这。`install -d` 对已存在的目录同样适用（幂等地重设属主/权限）。**但 `install -d` 只作用于目录本身、不递归移交已有内容的属主**：若 `data/` 已有旧内容（从非 Docker 部署迁移、或曾以别的 uid 跑过）且属主非 1000，`app.db`/`-wal`/`backups` 仍归旧属主、容器（uid1000）写不了——需**先停服务**再 `sudo chown -R 1000:1000 data` 递归移交属主；全新（空）目录无需。

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
[ -f .env ] || install -m 600 .env.example .env   # 填好 .env（见 §1；已存在则跳过，不覆盖已配密钥）
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
- **未完结升级不重复备份（且防 pair 丢失）**：一次多迁移的升级若后段失败，库会停在中间版本、`restart:unless-stopped` 反复重启。入口用 `data/.upgrade-in-progress` 标记去重，备份后把整个受控 pair 钉成 `data/backups/preupgrade.db` + `preupgrade.db.manifest.json`（移出 `backup-*.db` 轮转集，不受 `BACKUP_KEEP` 影响），标记内容记 `preupgrade.db` 绝对路径。重试时只有同名 manifest 仍在、两者都是 0600 regular file，且 manifest 的 `name` / `size` / `sha256` 与 payload 严格一致时，才沿用原升级前 pair 并跳过备份。两个成员都缺失时才会按当前状态重新备份；任一边残留、错配或损坏都 fail-closed 中止启动，不会用新备份覆盖可疑现场。未完结的升级链即使中途换目标版本，也共享这一份经验证的「原始升级前」pair。迁移成功即删标记、升级闭环；钉住 pair 保留至下次升级替换。
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

> **空版本行保护**：若日志报 `schema_version 表存在但无版本行，且已有业务表`，迁移器会在修改业务
> schema 前 fail-closed。这代表无法区分「旧版已跑过多少迁移」，不要盲填最新版本或反复重启。只有在确认
> `preupgrade.db` pair 确实早于该异常状态时才恢复它；首次检测到此状态时，entrypoint 可能刚把当前歧义库钉住为
> `preupgrade.db` + 同名 manifest，此时应找更早的已知正常 pair，或复制数据库到离线环境核对实际 schema 后再补写正确版本。

> 升级前如需人工快照，见 §5 手动备份。回滚：停机 → 退回旧代码/镜像 → build/pull + create 旧容器为停止态 → 恢复 DB → 启动。

---

## 5. 备份与恢复

### 5.1 备份机制

`scripts/backup.ts` 用 SQLite `VACUUM INTO` 产出 WAL 安全的一致性单文件 payload（对源库只读、不打断在线写入），并发布同目录受控 pair：`backup-<时间戳>-<随机>.db` + `backup-<...>.db.manifest.json`。两个临时文件都不匹配有效备份命名；VACUUM 完成后先把 payload rename 到最终 `.db`，再把 manifest rename 到最终名。**manifest 是 pair 的进程可见提交标志**：只有两者都是 0600 regular file，manifest 严格等于规范 v1 JSON（`method=sqlite-vacuum-into`），且 `name` / `size` / `sha256` 与 payload 匹配时，才是可消费备份。正常失败会收回本进程的 tmp 与未提交最终 payload；SIGKILL 仍可留下 tmp 或“有最终 `.db`、无 manifest”的孤儿，它们可能含完整敏感数据，但不进入有效备份/轮转/“今日已备”判据，必须确认无活跃写入后再人工处置。

`BACKUP_KEEP`（默认 7）只对已通过 pair 校验的 `backup-*.db` 计数和轮转；删除顺序与发布相反，先删 manifest 提交标志，再删 payload。`BACKUP_KEEP` 仅在未配置或空值时取默认值；非空值必须是 `>=1` 的十进制安全整数，否则手动/自动入口都在 VACUUM 与轮转前失败。manifest 是受控生成链的来源/完整性绑定，**不是数字签名或 MAC**：能同时改写 `.db` 与 manifest 的 root、存储管理员或入侵者仍可伪造新 pair。当前也没有 file/dir fsync 协议，因此发布 rename 与 manifest 提交只是进程可见契约，不承诺宿主掉电后 tmp、pair 成员、缺失状态或落盘顺序。

- **升级期自动**：容器启动时若 `schema-check` 判定**有待迁移**才备份（schema 已最新则跳过）；未完结升级的重试（含中途换目标版本）由 `.upgrade-in-progress` 标记去重。新生成的 `backup-*.db` pair 钉成 `preupgrade.db` pair 后移出轮转集；重试时必须重新验证整个 pair，不能只因 `.db` 路径存在就跳过备份。备份或 pin 失败即中止启动（fail-closed）。详见 §4。
- **每日自动**（P6-R2）：worker 每轮巡检末尾检查「今天（服务器本地日）是否已有备份」，没有就备一份。升级期备份只在有待迁移时才跑——不升级的日子，上次升级以来的数据本来没有任何快照，这条补上。
  - 判据落在**磁盘上的备份文件名**（不是进程内存标记）：容器 `restart:unless-stopped` 崩溃循环反复重启，也只会在「当天确实还没备过」时备一份，绝不产生备份 churn 把轮转集冲垮。
  - 保留份数复用 `BACKUP_KEEP`（默认 7）＝**日备份保约 7 天**，不额外加开关。日备份与手动备份共用同一 complete-pair 轮转集；`preupgrade.db` / `pre-restore.db` 及各自的 manifest 是钉住 pair，不匹配 `backup-*.db` 而豁免。
  - 日志：`[worker] 每日自动备份完成`。备份失败只记 `[worker] 每日备份出错`、不影响首检/巡检/结算。
  - ⚠️ 文件名里的时间戳是 **UTC**（`backup-2026-07-25T16-30-00-xxxxxx.db` 在 `TZ=Asia/Shanghai` 下属于本地的 07-26），判日时已做换算——按文件名肉眼对日期时注意这一层。
- 手动随时触发：

  ```bash
  docker compose exec app node scripts/backup.ts
  ls -la data/backups/
  docker compose exec app node scripts/backup-manifest.ts verify data/backups/<快照>.db
  ```

### 5.2 恢复演练（务必在上线前演练一次）

恢复输入不再是单个 `.db`，而是同目录同基名的受控 pair：`<snapshot>.db` + `<snapshot>.db.manifest.json`。恢复即“先证明 pair 属于受控备份链且当前字节一致，再用 payload 替换 `app.db`”。legacy 裸 `.db`、缺失/错配 manifest、任一成员是符号链接、hardlink/path alias、非 regular file 或权限不为 0600，以及 manifest 的版本、方法、名称、大小、SHA-256 不符，都与当前 `restore.sh` **不兼容**。

#### 首选：`scripts/restore.sh`（宿主侧运行，仓库根目录）

```bash
./scripts/restore.sh data/backups/backup-2026-07-26T01-00-00-a1b2c3.db
```

脚本先固定恢复身份：校验 `READY_TIMEOUT` → 用 `docker compose config` 唯一确认 `/app/data` bind source 与 `DATA_DIR` 的 realpath、dev/inode → 查询唯一 app 容器（尚不存在时只 `create` 为停止态），保存完整容器 ID、镜像 ID、初始运行态、`/app/data` mount source、`com.docker.compose.project/service/oneoff=False` 标签，以及当前 NetworkID/name/aliases。Compose 与实际容器的**全部 bind mounts**也会逐一物理规范化；任何 source 等于、包含或能暴露持久化 `RESTORE_STATE_DIR` 的路径都在建锁、停机、写 DB 前拒绝。容器缺失可按已核验配置创建为停止态；多个候选、额外同 service 容器、ID/image/label/mount/source/DATA_DIR 身份漂移或无法唯一解析则 fail-closed。脚本在 stop 前后、DB replace 前、start 前后、readiness 前后、网络发布前后与控制锁释放前反复核验同一 exact container；不会按容器名猜目标，也不会把并发 recreate 后另一个容器的 readiness 当成成功。

互斥与证据只有一个授权边界：宿主 operator-owned 的持久化 0700 private state root。sudo/root 路径默认为 Linux `/var/lib/xiaojimao-restore-state`、macOS `/var/db/xiaojimao-restore-state`；明确 `SUDO=` 的非 root 调用者默认为 `$HOME/.xiaojimao-restore-state`，也可用绝对路径 `RESTORE_STATE_DIR` 覆盖。root 必须是当前执行身份持有的实体 0700 目录，直接父目录必须是 operator/root 持有且不对 group/other 可写；symlink、错 owner/mode、非目录或可写 parent 都在 validator、容器变更和 DB 写入前 fail-closed。每个 helper 都重做 `lstat(root) → chdir(root) → stat(".")`，然后只对 allowlisted basename 用 `O_NOFOLLOW`、`O_EXCL`、0600 与相对 rename/unlink；private root 在正常收尾后保留，不删除重建。

同一 `DATA_DIR` 的成员是 `<state-key>.guard`、`<state-key>.control/` 和可选的 `<state-key>.published`；`data/.restore-in-progress` 只保存已停机后同文件系统 replace stage。guard 的随机 64-hex generation 只做一致性绑定，不是秘密；0600 candidate 以 hard link 原子取得 guard。规范 v3 `control-owner` JSON 绑定 generation、guard 内容、private root/control directory/owner file 的 dev:inode、state key、`DATA_DIR` 路径与 dev:inode。active control 的每次状态读写、来源固化、readiness body 发布及释放/删除前都重新核对同一 root/directory/control-owner/guard identity；任一 identity 漂移、未知 guard/candidate 或部分清理失败都保留证据并 fail-closed，不会用宽泛 `rm -rf`。下一次 restore 只信任匹配的 v3 owner record；伪造、ownerless 或 generation 不一致的 control 只会 exit 4，Docker stop/disconnect 均为 0。

`<state-key>.published` 是简单、版本化、原子写入的 v3 终态记录，绑定 generation、state key、`DATA_DIR` dev:inode、exact container ID、Compose project/service 和 `network-published`。它与 control 都位于同一 private root，因此**不引入 HMAC、anchor key、密钥轮换或跨机密钥恢复**：app/备份目录写入者无法进入该 root，而与 restore operator 同 UID 或 root 的攻击者可以同时改写 record 与任何同权限 key，签名不增加安全性，两者本就不在本轮威胁边界内。legacy `${DATA_DIR}.restore-control*` 或其他旧状态不会被自动信任或迁移。
启动时对 `<state-key>.published` 保留三态：只有合法 0600 regular file 是“存在”，只有确认 ENOENT 是“缺席”，错 mode/owner、hardlink、目录、symlink 或无法观测都是“已占位但不可信”，exit 4 且不运行 validator、不操作 Docker、不改 DB。

来源校验与 SQLite 校验是两道不同的门：宿主侧 ingest 在任何 SQLite 打开或临时容器启动前，用 `O_NOFOLLOW` 各打开一次 manifest 与 payload，并只从这些 FD 做 `fstat`、规范 v1 JSON 解析、name/size 绑定与流式复制。payload 从同一个已验证 FD 直接写入 `O_EXCL`/0600 的 host-only 目标；复制完成后对目标重新计算 SHA-256，且 source FD 的 dev/inode/size/metadata、最终 pathname 身份与 manifest 均未漂移，才最后发布 host-only manifest。symlink、hardlink、rename/path replacement、短读、原 inode 改写/截断或 digest 不一致都在 stop 前拒绝；后续 trusted stage 的 pair 复核也只从 `O_NOFOLLOW` 打开的 FD 读取，不再 `lstat` 后重新按 pathname 打开。

SQLite 校验再借已捕获的 exact app image ID 创建一次性 validator：不用 `docker compose run`，不继承 service 网络或 `/app/data` bind，固定 `--network none`、只读 rootfs、`cap-drop ALL`、`no-new-privileges`，且只挂一个只读 `/snap.db`。validator 使用当次实际挂载的 host-only 副本或 replace stage 的数值 owner UID/GID，这是读取该 0600 bind 所需的最小身份；默认 sudo 路径生成的副本可能本来就是 root-owned，只有此时才使用 `0:0`，不会把 caller-owned 文件无条件提权。每次 create 前先生成高熵随机 name/token，并登记 expected exact image 与 snapshot identity；容器带项目专用 ownership labels。create 返回失败、空白或异常 stdout 时只按 exact name inspect，且只有 name/token/labels/image/唯一只读 snapshot mount 全匹配才按完整 ID 删除；foreign collision、inspect 或 rm 结果不明都不猜删，保留 name/token 供人工核对并 fail-closed。正常路径在 start 前继续逐项 inspect 镜像、Env、用户、entrypoint、命令、网络、rootfs、capability 与 mount；任一属性漂移或校验容器无法确认清理都中止恢复。精确停止已捕获容器后，payload 再复制到 DATA_DIR 内 stage，逐字节 `cmp`、用 FD 重新核对 manifest digest，并二次执行 header + `quick_check`。现场 `app.db` 以 `VACUUM INTO` 留为 `pre-restore.db` payload，最终同名 manifest 生成且 pair 二次校验通过后，才允许写 `replace-armed`、原子替换 DB、清旧 sidecar 与升级标记。

数据库替换后、app 启动前，脚本用 Docker CLI 按**已捕获的 exact container ID**从全部捕获 NetworkID 断开，并确认停止态容器网络集合为空；不能完整隔离就拒绝启动。释放 DATA_DIR 内 stage 后，脚本只以 `docker start <exact-id>` 启动这个无网络容器，并用 `docker exec <exact-id>` 调镜像已有 Node 从容器内 loopback 请求 `127.0.0.1:3000/api/ready`。因此未验收实例不经宿主发布端口或反代接流量；正常 `restart` policy 也不会替它恢复已断开的网络。

发布顺序固定为 `networks-isolated` → `app-started` → `ready-accepted` → `networks-reconnecting` → `network-published`。strict HTTP 200 + 原始字节 JSON `{"ok":true}` 且最终身份复核通过后，脚本**先持久写 `ready-accepted`，再做任何 network connect**；随后只用 Docker CLI 按 exact NetworkID 重连并重放 aliases，复核 NetworkID/name/aliases 集合。运行态 endpoint MAC 是 Docker 的动态属性，不捕获、不重放、不比较。全部网络与身份复核通过后才写 `network-published`；这是允许已验收实例继续服务的唯一提交点。任一重连失败都会尽力撤回全部已见 endpoint；能确认完全撤回时停止 exact 容器并写 `publication-failed`，不能确认时保留 `ambiguous-publication`，两者都非零退出、保留 accepted 与控制锁且绝不打印恢复成功。释放 control 前，脚本先在 private root 中 `O_EXCL` 原子发布 v3 `<state-key>.published`，再删除 control 阶段成员和目录、释放 guard，最后才删 published。任一 unlink/rename/rmdir 步骤失败都保留可明确判定的 private 发布证据；下一次 restore 可按其 exact container/project/service 身份保留已验收 A 并收口额外 B，不会信任 app 可写区域内伪造的 handoff。

- 🔴 **来源、完整性和格式是三种不同的判据**：manifest pair 证明“受控链声明这些字节是 `sqlite-vacuum-into`，且当前文件名/大小/摘要未漂移”；`PRAGMA quick_check` 只检查当前字节的 SQLite 结构，不证明产生方法、业务完整性或是否遗漏 WAL；header offset 18/19 的 `1/1` 只是当前恢复器允许的 rollback-journal 格式形态，**不是 `VACUUM INTO` provenance，也不能单独证明该主文件是一致性单文件快照**。只有 pair gate、`1/1` 格式 gate 和 `quick_check` 全部通过才继续；任一失败都发生在 stop 与 DB 写入前。
- 🔴 **WAL 主文件与未知格式仍 fail-closed**：活动 WAL 库的已提交数据可能只在 `-wal` 里，单独恢复 `2/2` 主文件可以结构完好、`quick_check=ok`、readiness 也过，但静默少数据。因此 `2/2`、`0/0`、混合或其他值都拒绝；干净关闭的 WAL 主文件即使内容完整也属已知误拒。需从源库在可信环境中重新走受控 `VACUUM INTO` 备份发布链，产出 payload 与同名 manifest，并收紧到 0600；不得为无法解释来源的旧 `.db` 直接补写 manifest 来绕过边界。
- 🔴 **现场留存也是 pair，不是单个文件**：`stop` 发的 SIGTERM 不保证 WAL checkpoint，所以 `pre-restore.db` payload 必须由 `VACUUM INTO` 生成，不能 `cp`。发布时先撤下旧 manifest、再用同目录 rename 就位新 payload、最后生成并复核 `pre-restore.db.manifest.json`；manifest 失败或 SIGKILL 落在两者之间时，裸 `pre-restore.db` 不是可恢复点，且本次不允许继续换库。
- 🔴 **用 `pre-restore.db` pair 本身当恢复源是安全的**：脚本在停 app、重建同名 pair 之前，已把原 payload 与 manifest 固化并校验到 app 不可见的 host-only 副本；停机后的 stage 再与该 manifest 核对，所以现场留存覆盖原路径不会改变本次已固定的恢复字节。
- 🔴 **FD ingest 的威胁边界**：它负责抵御 app 可写备份目录中的最终组件 symlink、hardlink、rename/path replacement 与普通并发改写，并确保被验证和被固化的是同一 payload FD。manifest v1 仍不是签名/MAC，也没有可信时间戳；可同时重写 pair、祖先目录或宿主元数据的 root/存储管理员，以及可任意管理 Docker 的外部 Docker-admin，仍在本方案威胁边界之外。本流程也继续不提供 file/dir fsync 或宿主掉电持久顺序保证。
- 🔴 **guard / EXIT / SIGINT / SIGTERM 是一个所有权约束的收尾契约**：trap 在 guard 取得和精确 stop 之前安装，并按 `acquiring` / `active` 阶段分流。取得期只能删本进程的 candidate，且仅在 guard hard-link 所有权证据匹配时才能收回已创建的 control；active 期若 private root/guard/control-owner identity 丢失或漂移，脚本不再读写或删除该 pathname 下的状态，但会先用本进程内已捕获的 exact container/project/service 做 containment：`network-published` 尚未提交时停止并撤回全部已见 endpoint，已提交时保留 accepted exact 实例并只收口替代候选，然后保留锁与审计证据。EXIT 也负责清理孤立 validator 容器，清理不可确认时把成功改为失败。最终 `mv` 前先写 `replace-armed`，并把 public lock/stage 的 exact dev:inode 写入 private control；进程内 cleanup 与 SIGKILL 后的下一次 restore 都从该 trusted control 严格读取两条 identity，再复用同一个 replacement-status：`app.db` 已成为 exact stage inode 才是 replaced，exact stage 仍位于 exact lock inode 才是 unreplaced，identity 缺失/格式错误、lock pathname 被 rename/replaced 或源 inode 漂移都属于 unknown。confirmed-unreplaced 收尾必须先成功 unlink exact stage 并 rmdir exact lock，之后才允许按初始运行态恢复旧 app；只读 probe 成功不能替代真正 release 成功。未替换时保留当前 DB/WAL；已替换时先清旧 WAL/SHM，再推进 `sidecars-clean`。DB 替换后到 `network-published` 前的失败/信号都会尽力停止未发布实例并保留锁；只有 `network-published` 已提交、control/guard/private published 已按协议释放后才撤销 trap。SIGINT / SIGTERM 分别以 130 / 143 退出。
- 🔴 **并发与进程级硬中断 fail closed**：任何 owner PID/阶段判断之前，残留 control 都必须先通过 v3 root/directory/control-owner/linked-guard identity；缺失或漂移时不读取其中的 container ID/marker，也不做 Docker containment。`replace-armed` 存在时还必须从该 trusted control 读到合法且匹配的 public lock/stage identity，并用 exact replacement-status 判定 DB 是否已替换；不得由原 pathname 上 `snapshot.db` 的存在/缺席推断。identity 缺失、格式错误或 pathname/inode 漂移都保持 unknown，stop/disconnect 为 0。Linux owner 严格记录为 `v2 linux-proc <boot_id> <starttime_ticks>`。同 boot 下 PID + field-22 start ticks 匹配才是 `alive+matching`；boot ID 变化或可读 stat 的 start ticks 不同可判 `definitely stale`。若 `/proc/<pid>/stat` 不可读，脚本只在**同一观察通道的 `id -u` 严格返回 0**后才允许枚举 `/proc` 并由目标缺席判 stale。非 root 在 `hidepid=2/invisible` 下可能看得到同 UID 的 PID 1，却看不到 live cross-UID owner；因此“枚举成功 + PID 1 可见 + 目标缺席”**对非 root 不是死亡证据**，必须保持 `unknown`。格式损坏、EPERM、提权失败、枚举不完整或其他无法确认情况也一律 `unknown`。只有 `definitely stale` 才允许 stop/断网收口；`alive` 与 `unknown` 都以 4 阻断、保留原锁/private published 证据且不碰容器或网络。唯一独立终态是仅剩有效 0600 v3 `<state-key>.published` 而 owner/control 元数据已清除的已发布状态；Darwin 仅保留版本化 UID + `ps lstart` 回退，其他非 Linux/Darwin 宿主在建锁、停机前失败。SIGKILL 后根据 host-only 阶段收口：
  - `app-started` 但无 `ready-accepted`：实例原本应保持无网络；下一次 restore 先读取锁内 exact ID，精确 stop 并确认无流量网络，再保留锁、退出 4 交人工处理。
  - 有 `ready-accepted` 但无 `network-published`：无论仍未重连、部分重连，还是重连已生效但来不及写下一阶段，内容都已验收但发布尚未提交；下一次 restore 会精确停止并撤回可见 endpoint，保留 accepted、当前阶段以及已有的 `publication-failed` / `ambiguous-publication` 证据。
  - 有 matching `ready-accepted` + `network-published`，或锁释放失败留下携带 exact ID/project/service 的 0600 private published record：实例已验收并发布，不自动反向停机；残锁明确表示只差释放/人工核对。
  - 捕获 ID 消失、Compose 指针漂移或出现额外同 service 容器时，脚本按 control/private published 内的 exact ID 与固定 project/service/nononeoff 标签枚举，先停止能精确确认的未发布实例，再 fail-closed；绝不接受替代容器的 readiness。若 Docker 标签枚举或 Compose 当前指针查询本身失败，脚本不会把空结果当成“没有额外实例”，而会保留 `ambiguous-publication` 与状态锁。
  - 这项保证覆盖 restore owner 进程的 SIGKILL 与正常 restart policy，**不承诺**在 restore 已被杀后继续对抗另一个具 Docker 管理权限的人为 `recreate` / `network connect`。方案不新增常驻服务、不改反代/Compose 拓扑、不挂 Docker socket，也不引入新的 Docker-admin 主体。
  - ⚠️ **这不是宿主断电一致性承诺**：脚本没有对 marker、rename、sidecar unlink 做 `fsync` 屏障，SIGKILL 回归也只能证明进程级硬中断，不能证明掉电后的磁盘持久顺序。若 restore 期间宿主掉电/强制重启，无论锁是否仍可见，都先保持 app 停止，人工核对 `app.db`、`app.db-wal`/`app.db-shm` 与锁目录后再启动；不能只凭 marker 存在性自动判断。

- 🔴 **分叉守卫**：若 `data/.upgrade-in-progress` 存在（＝上次升级没走完），脚本**拒绝执行**并打印指引，退出码 3。先把当前安全的 `restore.sh` 单独复制到 checkout 外，再停 app、退回旧代码/镜像、`docker compose build app`（使用镜像 tag 的部署则 `pull app`）、`docker compose create --force-recreate app` 重建为**停止态**，最后用保留脚本带 `--after-image-rollback` 恢复。数据库恢复前禁止 `up`/`start`，否则旧服务会先运行 entrypoint 并可能写入中间 schema。
- 校验用 `/api/ready`（不是 `/api/health`）：liveness 通过只说明进程活着；restore 仅接受捕获容器 loopback 的 HTTP status **严格等于 200** 且响应 JSON **`ok === true`**。body 先写调用者侧 0600 `mktemp`，再由 FD-bound control helper 重新绑定 private root/control identity 并以 `copy-in` 发布到 host-only control，随后按原始字节解析；不经过会吞掉 NUL 的 shell 变量，也不要求普通调用者直接写 root-owned 控制目录。默认最多 60s（`READY_TIMEOUT` 可覆盖），使用绝对 deadline 并把每轮 probe/sleep 钳到剩余时间；302、其他 2xx、`ok:false`、空响应、NUL、额外内容或畸形 JSON 都会在 deadline 后失败、再次停机并保留 restore 状态。readiness 本身还会验证常驻连接、`DB_PATH` 当前 dev/inode 是否仍是启动时文件、磁盘新只读连接，以及两侧 schema 是否都与镜像匹配。
- 环境变量：`SUDO=`（macOS Docker Desktop，或宿主 UID 与容器 uid1000 明确隔离时可跳过；Linux uid1000 调用者必须保留 sudo/root。清空后仍可读同 UID owner 的 `/proc` 指纹，但不能由 cross-UID PID 缺席推断死亡）、`DATA_DIR`、`BACKUP_DIR`、`RESTORE_STATE_DIR`（只接受绝对路径的 operator-owned 0700 持久化目录）、`APP_URL`（仅用于超时后的宿主侧排障提示）、`READY_TIMEOUT`（默认 60，十进制 `1..86400`）。state root 边界、timeout、owner 指纹能力与同 UID 隔离条件都在停机/DB 写入前校验。
  - `BACKUP_DIR` 可自由改到任意路径（含 `data/` 之外）：脚本用显式 `-v` 把它挂进一次性容器，不依赖 compose 里那条 `./data:/app/data`。
  - 🔴 `DATA_DIR` **必须与 Compose 中绑到 `/app/data` 的唯一宿主 bind source 指向同一实体目录**（默认是 `./data:/app/data`），且捕获容器的实际 `/app/data` 挂载必须一致。脚本持续调用 `docker compose config --format json app`、`docker compose ps --all -q app` 与只读 `docker inspect` 核对；无容器时允许按已核验配置 `create app` 为停止态，多个容器、实际挂载缺失/歧义/named volume、旧容器与 Compose 不一致、额外 bind 暴露 private state root，或恢复过程中 ID/source/image/dev/inode 漂移都 fail-closed。相对/绝对路径或 symlink 最终落到同一目录可通过，后续写入固定到已验证的物理绝对路径。
  - 🔴 网络隔离/恢复拒绝静态 IPv4/IPv6、link-local、`interface_name`、Compose 显式 MAC、driver opts、links 或非零网关优先级；这些配置不能由本方案可靠重放。普通动态 endpoint MAC 不作为身份，只固化并复核 NetworkID/name/aliases。停止态容器的 Compose config hash 陈旧同样在停机前拒绝。
- 退出码：0 仅表示 strict readiness、exact 身份与网络发布均通过，且 control/guard/private published 已按顺序释放 / 1 输入 pair 无效（缺失、符号链接、非 0600 regular file、manifest 非规范 v1/非 `sqlite-vacuum-into`/名称大小摘要错配）、payload 非 SQLite/未过 `quick_check`/header 18/19 不是 `1/1`、隔离 validator 属性或清理失败、Compose/容器身份无法确认、隔离/重连/sidecar/状态锁清理失败、readiness 超时或未接受 / 2 用法错（含非法 `READY_TIMEOUT`、非默认 `DB_PATH` 与「快照就是当前库本身」）/ 3 被升级标记拒绝 / 4 已有并发、异常中断 restore 锁、不可信 state root 或未知 guard/candidate / 130 收到 SIGINT / 143 收到 SIGTERM。`network-published` 前的非成功退出默认停止/隔离 app 并保留 host-only 状态；已写 `network-published` 但收尾失败则保留 0600 private published record，不反向停掉已验收实例。

演练完数据核对无误后，若不再需要现场回滚点，必须成对删除 `data/backups/pre-restore.db.manifest.json` 与 `data/backups/pre-restore.db`（先撤 manifest 提交标志，再删 payload）。它们不占 `BACKUP_KEEP` 名额，但不会自动清理。

#### 脚本不可用或布局不受支持时：保持 fail-closed

不要维护第二套裸 `cp/install/rm/start` 手工配方，也不得为 legacy `.db` 随手生成 manifest 伪装受控来源。那些路径会绕过 manifest pair gate、隔离 validator、`1/1` 格式 gate、`quick_check`、私有 stage、guard/互斥锁、信号 trap 与“未替换时保留旧 WAL / 已替换时先清 sidecar 再启动”的状态机，很容易把恢复做成数据丢失或混库。

- 非默认 `DB_PATH` 当前明确不受 `restore.sh` 支持；不得用 `unset DB_PATH`、清空 Compose 配置或猜测容器路径到宿主路径的映射来绕过。保持 app 与真实配置不变，改用经独立复核、明确支持该挂载布局且复用同等安全门的专用恢复工具。
- 升级失败回滚仍使用本脚本，只把旧容器预先重建为停止态：

  ```bash
  RECOVERY_SH="$(mktemp)"
  install -m 700 scripts/restore.sh "$RECOVERY_SH"
  docker compose stop app
  git checkout <升级前的旧提交或 tag>
  docker compose build app
  docker compose create --force-recreate app
  "$RECOVERY_SH" --after-image-rollback data/backups/preupgrade.db && rm -f "$RECOVERY_SH"
  ```

  使用远端镜像 tag 的部署可将 `docker compose build app` 换为 `docker compose pull app`。恢复脚本成功前禁止 `docker compose up` 或 `docker compose start app`。

### 5.3 异机同步（离线副本）

`data/backups/` 只在本机——磁盘坏、机器丢、误删都会连备份一起没。用 `scripts/sync-backups.sh` 定期推到另一台机器：

```bash
REMOTE=user@backup-host:/srv/xjm-backups ./scripts/sync-backups.sh
# 或： ./scripts/sync-backups.sh user@backup-host:/srv/xjm-backups
```

- **宿主侧运行**，容器内不做 ssh（容器不该持有远端私钥，镜像也没装 rsync/ssh）。需要宿主装 `rsync`、配好到远端的免密 ssh。
- 脚本只枚举并严格验证 `backup-*.db`、`preupgrade.db`、`pre-restore.db` 的完整受控 pair，先固化到 0700 临时目录，再把全部 payload 传完，最后传 manifest；临时文件、裸 `.db` 和不完整/错配 pair 不会进入传输集。**每份备份必须同时传 `.db` 与相邻的 `.db.manifest.json`，不能只拿 payload。**
- 🔴 **rsync 传输过程不具备跨两个文件的 pair 原子性**：传输窗口内远端可能暂时只有 payload；固定名称的 `preupgrade.db` / `pre-restore.db` 更新时，也可能短暂出现新 payload 配旧 manifest。manifest-last 只提供提交顺序，不把两次 rsync 变成单一原子操作。远端盘点、复制和恢复消费者必须重新执行与 §5.2 相同的 pair 校验，只接受相邻、同名、0600 regular file 且 manifest 的名称/大小/SHA-256 与 payload 匹配的 pair。
- 🔴 **故意不加 `--delete`**：本地按 `BACKUP_KEEP` 每天轮转，加了 `--delete` 会把本地的轮转删除传播到异机——异机副本就退化成本地的镜像，既拿不到更长的留存，本地误删/被入侵删库也会立刻同步过去。代价是**远端只增不减，需自行清理**，例如在远端配：

  ```bash
  # 远端 crontab：完整 pair 保留 90 天；先撤 manifest 提交标志，再删 payload
  find /srv/xjm-backups -type f -name 'backup-*.db.manifest.json' -mtime +90 \
    -exec sh -c 'for manifest do db=${manifest%.manifest.json}; rm -f -- "$manifest" && rm -f -- "$db"; done' sh {} +
  ```

- 宿主 crontab 示例（每天 03:20 同步一次；worker 的每日备份在当天首个 tick 就完成了）：

  ```bash
  20 3 * * * cd /opt/xiaojimao-hub && REMOTE=user@backup-host:/srv/xjm-backups ./scripts/sync-backups.sh >> /var/log/xjm-sync.log 2>&1
  ```

  > 环境变量：`BACKUP_DIR` 覆盖本地目录（默认 `data/backups`）。cron 里务必先 `cd` 到仓库根，或用绝对路径的 `BACKUP_DIR`。

从异机副本恢复时必须把 pair 两边复制到本机同一目录，保持原文件名，并确保两者都是 0600；`restore.sh` 的参数仍传 payload 路径，脚本会自行查找相邻 manifest。脚本不要求 pair 位于 `data/backups/`：

```bash
scp -p user@backup-host:/srv/xjm-backups/backup-2026-07-26T01-00-00-a1b2c3.db /secure/local-dir/
scp -p user@backup-host:/srv/xjm-backups/backup-2026-07-26T01-00-00-a1b2c3.db.manifest.json /secure/local-dir/
chmod 600 /secure/local-dir/backup-2026-07-26T01-00-00-a1b2c3.db /secure/local-dir/backup-2026-07-26T01-00-00-a1b2c3.db.manifest.json
./scripts/restore.sh /secure/local-dir/backup-2026-07-26T01-00-00-a1b2c3.db
```

---

## 6. 前置反代与 HTTPS

容器只监听宿主 `127.0.0.1:3000`，**不直接对公网**。TLS 由前置反代（nginx/Caddy）终结后转发。

### 6.1 nginx 示例

```nginx
server {
    listen 80;
    server_name hub.example.com;
    return 301 https://hub.example.com$request_uri;  # 固定域名，不反射客户端 Host
}

server {
    listen 443 ssl http2;
    server_name hub.example.com;        # ← 你的域名

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    # 最小浏览器安全头；确认 HTTPS/证书续期稳定后再启用 HSTS。
    add_header Strict-Transport-Security "max-age=15552000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 收紧慢请求与异常大 body；本项目不需要无限上传。
    client_max_body_size 2m;
    client_body_timeout 15s;
    send_timeout 60s;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        # 覆盖 OAuth finish 的约 345s operation fence，避免慢 CPA 合法请求被反代提前截断。
        proxy_read_timeout 360s;
        proxy_set_header   Host              hub.example.com;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host  hub.example.com;   # 钉死你的域名，别用 $host（默认/唯一 server 下 $host 兜底取客户端 Host 头，伪造照样透传）；TRUST_FORWARDED_HEADERS=true 时据此推断域名，见 §6.2
    }
}
```

HSTS 会被浏览器记住；只在该域名已稳定提供 HTTPS、证书自动续期已验证后启用。示例故意不加
`includeSubDomains`/`preload`，也不引入大型 CSP，避免把本项目之外的子域或现有前端资源一起锁死。

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

### 9.1 两个探针

| | `GET /api/health`（liveness） | `GET /api/ready`（readiness） |
|---|---|---|
| 判什么 | 进程活着 | 常驻连接可读 + `DB_PATH` 仍是启动时 dev/inode + fresh 磁盘连接可读 + 两侧 schema 版本 === 代码要求 |
| 响应 | 恒 `200 {"ok":true}` | `200 {"ok":true}` / `503 {"ok":false}` |
| 不通该做什么 | **重启容器** | **摘流量 + 告警，别重启** |
| 谁在用 | 镜像 `HEALTHCHECK`、反代存活判断 | 外部拨测、反代 upstream 摘除、恢复校验 |

两者都无鉴权、无副作用，响应体只有 `ok` 字段——不带版本/路径/配置/账号信息（§8）。不就绪的具体原因（schema 版本差多少等）只进服务端日志：`[ready] 未就绪：...`。

> readiness 不是全库 `quick_check`：它能发现路径被 unlink/换 inode、磁盘 schema 不可读或版本不匹配，但不承诺识别任意业务数据页损坏。恢复流程另用 `PRAGMA quick_check` 检查当前 payload 的 SQLite 结构，并且仍须同时通过 manifest pair 的来源/摘要门和 header 格式门；`quick_check` 本身不证明 `VACUUM INTO` 来源、业务完整性或没有遗漏 WAL。

> 🔴 **`HEALTHCHECK` 故意仍用 liveness**：schema 落后时重启容器修不好问题（迁移是部署步骤，不是启动时自动跑），只会让容器反复重启进 churn 循环。readiness 的用途是让人/监控知道「这实例现在不该接流量」。

### 9.2 排查

- **看日志**：`docker compose logs -f app`。关键行：`[migrate] 完成`、`[worker] 后台巡检已启动`、`[backup] 完成`、`[worker] 每日自动备份完成`。
- **`/api/ready` 返回 503**：先看日志里的 `[ready] 未就绪` 行。最常见是 schema 版本不匹配——升级时漏跑迁移，或还原了旧版本的快照。跑 `docker compose exec app node scripts/schema-check.ts` 看详情。
- **确认非 root**：`docker compose exec app id` → `uid=1000`。
- **确认库落卷**：宿主 `ls -la data/`，删容器重建后 `app.db` 仍在即为持久成功。
- **日志轮转**：compose 已配 json-file `max-size=10m`、`max-file=5`，防磁盘被撑爆。

### 9.3 监控接线（两条，都是可选）

单机规模不上 Prometheus，两条轻量接法覆盖「服务挂了」和「worker 静默死了」：

**① dead-man 心跳（catch「进程还在但 worker 不干活了」）**

worker 每轮巡检**三段全部成功**后 GET 一次 `HEARTBEAT_URL`（节流：最少隔 5 分钟）。有段抛错就不发——外部超时后告警。发送失败只记 `[worker] 心跳发送失败`，不影响巡检。

- [healthchecks.io](https://healthchecks.io)：建一个 Check，Period 设 5 分钟、Grace 设 10 分钟，把它给的 ping URL 填进 `.env` 的 `HEARTBEAT_URL`，重启容器生效。超时不打卡即邮件/Telegram 告警。
- [Uptime Kuma](https://github.com/louislam/uptime-kuma) 自托管：新建 **Push** 类型监控，Heartbeat Interval 设 300s、Retries 2，把 Push URL 填进 `HEARTBEAT_URL`。

  ```bash
  # .env
  HEARTBEAT_URL=https://hc-ping.com/<your-uuid>
  ```

  > 填的值必须 `http://` 或 `https://` 开头，否则启动时告警一次并按未配置处理（日志不回显该值——心跳 URL 常含 uuid 型密钥）。留空/注释 = 关闭。

**② 外部拨测 `/api/ready`（catch「服务挂了 / DB 连接或文件身份失配 / schema 不匹配」）**

在 Uptime Kuma 建 HTTP(s) 监控指向 `https://<你的域名>/api/ready`，Accepted Status Codes 只填 `200`——未就绪时返回 503 即触发告警。间隔 60s 足够。

> 两条互补：拨测证明「外部能访问且实例就绪」，心跳证明「后台 worker 还在正常干活」。只有拨测的话，worker 卡死但 HTTP 正常时不会有任何告警。

---

## 附：常用命令

```bash
docker compose up -d --build        # 部署/升级
docker compose logs -f app          # 跟随日志
docker compose exec app node scripts/backup.ts   # 手动生成受控备份 pair
./scripts/restore.sh <payload.db路径> # 从相邻 payload + manifest pair 恢复（见 §5.2）
REMOTE=user@host:/path ./scripts/sync-backups.sh # 验证并推送完整 pair（见 §5.3）
docker compose exec app date        # 核对时区
docker compose exec app id          # 核对非 root
docker compose down                 # 停并删容器（保留宿主 ./data）
curl -s http://127.0.0.1:3000/api/health   # liveness
curl -s http://127.0.0.1:3000/api/ready    # readiness（常驻/新连接、DB 文件身份、schema 版本）
```
