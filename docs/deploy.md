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
- **未完结升级不重复备份（且防快照丢失）**：一次多迁移的升级若后段失败，库会停在中间版本、`restart:unless-stopped` 反复重启。入口用 `data/.upgrade-in-progress` 标记去重，备份后**把升级前快照钉成 `data/backups/preupgrade.db`**（改名移出 `backup-*.db` 轮转集——`lib/backup.ts` 轮转只认 `^backup-.*\.db$`，故 `BACKUP_KEEP` 与手动 `backup.ts` 都不会把它转掉），**标记内容记的就是这份 `preupgrade.db` 的绝对路径**：重试时先验证该快照仍在——**在就跳过备份**、沿用它作回滚点（未完结的升级链哪怕中途换目标版本，如原目标 v12 卡住、又部署 v13 的新镜像，也共享这同一份「原始升级前」快照）；**快照已丢**（`BACKUP_DIR` 被改到非持久路径、或快照被删）**则重新备份当前状态**（有回滚点总比裸迁移强）。迁移成功即删标记、升级闭环（`preupgrade.db` 作为额外回滚副本留着，至多一份，下次升级 `mv` 覆盖）。这样崩溃循环 / 跨目标重试 / 升级卡住期间手动备份，既不会用中间态备份 + `BACKUP_KEEP` 轮转挤掉唯一的「升级前」回滚点，也不会在快照丢失时没回滚点就裸跑迁移。
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
> `preupgrade.db` 确实早于该异常状态时才恢复它；首次检测到此状态时，entrypoint 可能刚把当前歧义库钉住为
> `preupgrade.db`，此时应找更早的已知正常备份，或复制数据库到离线环境核对实际 schema 后再补写正确版本。

> 升级前如需人工快照，见 §5 手动备份。回滚：停机 → 退回旧代码/镜像 → build/pull + create 旧容器为停止态 → 恢复 DB → 启动。

---

## 5. 备份与恢复

### 5.1 备份机制

`scripts/backup.ts` 用 SQLite `VACUUM INTO` 产出 **WAL 安全的一致性单文件快照**（对源库只读、不打断在线写入），先写唯一 `.tmp-backup-*`，完成后以同目录 rename 在**进程可见 namespace** 中发布为 `data/backups/backup-<时间戳>-<随机>.db`，并按 `BACKUP_KEEP`（默认 7）只保留最新 N 份。`BACKUP_KEEP` 仅在未配置或空值时取默认值；非空值必须是 `>=1` 的十进制安全整数，否则手动/自动入口都会在 VACUUM 与轮转前失败，绝不静默回退后删旧备份。临时库在 VACUUM 写入前就以 0600 创建；SIGKILL 后遗留的 `.tmp-backup-*` 可能含完整敏感数据库，它不会进入有效备份/轮转/“今日已备”判据，但必须确认无活跃写入后再人工校验或清理。当前没有 file/dir fsync 协议，因此不承诺宿主掉电后 tmp、最终名、缺失状态或落盘顺序。

- **升级期自动**：容器启动时若 `schema-check` 判定**有待迁移**才备份（schema 已最新则跳过）；未完结升级的重试（含中途换目标版本）由 `.upgrade-in-progress` 标记去重，标记记录升级前快照（备份后钉成 `data/backups/preupgrade.db`、改名移出 `backup-*.db` 轮转集，不被 `BACKUP_KEEP`/手动备份轮转掉）的绝对路径、**验证快照仍在才跳过备份**（快照丢失则重新备份当前状态），保住迁移前唯一回滚点，迁移成功即清标记；备份失败即中止启动（fail-closed）。详见 §4。
- **每日自动**（P6-R2）：worker 每轮巡检末尾检查「今天（服务器本地日）是否已有备份」，没有就备一份。升级期备份只在有待迁移时才跑——不升级的日子，上次升级以来的数据本来没有任何快照，这条补上。
  - 判据落在**磁盘上的备份文件名**（不是进程内存标记）：容器 `restart:unless-stopped` 崩溃循环反复重启，也只会在「当天确实还没备过」时备一份，绝不产生备份 churn 把轮转集冲垮。
  - 保留份数复用 `BACKUP_KEEP`（默认 7）＝**日备份保约 7 天**，不额外加开关。日备份与手动备份、升级期备份共用同一轮转集（`preupgrade.db` / `pre-restore.db` 因文件名不匹配 `backup-*.db` 而豁免）。
  - 日志：`[worker] 每日自动备份完成`。备份失败只记 `[worker] 每日备份出错`、不影响首检/巡检/结算。
  - ⚠️ 文件名里的时间戳是 **UTC**（`backup-2026-07-25T16-30-00-xxxxxx.db` 在 `TZ=Asia/Shanghai` 下属于本地的 07-26），判日时已做换算——按文件名肉眼对日期时注意这一层。
- 手动随时触发：

  ```bash
  docker compose exec app node scripts/backup.ts
  ls -la data/backups/
  ```

### 5.2 恢复演练（务必在上线前演练一次）

快照是完整一致的库文件，恢复即「用某份快照替换 app.db」。

#### 首选：`scripts/restore.sh`（宿主侧运行，仓库根目录）

```bash
./scripts/restore.sh data/backups/backup-2026-07-26T01-00-00-a1b2c3.db
```

脚本先固定恢复身份：校验 `READY_TIMEOUT` → 用 `docker compose config` 唯一确认 `/app/data` bind source 与 `DATA_DIR` 的 realpath、dev/inode → 查询唯一 app 容器（尚不存在时只 `create` 为停止态），保存完整容器 ID、镜像 ID、初始运行态、`/app/data` mount source、`com.docker.compose.project/service/oneoff=False` 标签，以及当前 NetworkID/name/aliases。Compose 与实际容器的**全部 bind mounts**也会逐一物理规范化；任何 source 等于或包含 `${DATA_DIR}.restore-control` / accepted handoff 的祖先目录都在建锁、停机、写 DB 前拒绝。容器缺失可按已核验配置创建为停止态；多个候选、额外同 service 容器、ID/image/label/mount/source/DATA_DIR 身份漂移或无法唯一解析则 fail-closed。脚本在 stop 前后、DB replace 前、start 前后、readiness 前后、网络发布前后与控制锁释放前反复核验同一 exact container；不会按容器名猜目标，也不会把并发 recreate 后另一个容器的 readiness 当成成功。

互斥与证据分两层：`data/.restore-in-progress` 只保存停机期同文件系统 replace stage；`${DATA_DIR}.restore-control` 是未挂进 app 的宿主控制锁，保存 exact ID、身份与阶段。默认 sudo/root 路径下两层目录保持 root-owned 0700，状态文件以受保护目录内 0600 临时文件 + rename 写入。源快照先固化到 host-only 0600 副本并做 header + `quick_check`；精确停止已捕获容器后，再复制到 DATA_DIR 内 stage，逐字节 `cmp` 并二次校验。现场 `app.db` 以 `VACUUM INTO` 留为 `pre-restore.db`，随后写 `replace-armed`、同目录原子 rename、交还最终 DB 属主、清旧 sidecar 与升级标记。

数据库替换后、app 启动前，脚本用 Docker CLI 按**已捕获的 exact container ID**从全部捕获 NetworkID 断开，并确认停止态容器网络集合为空；不能完整隔离就拒绝启动。释放 DATA_DIR 内 stage 后，脚本只以 `docker start <exact-id>` 启动这个无网络容器，并用 `docker exec <exact-id>` 调镜像已有 Node 从容器内 loopback 请求 `127.0.0.1:3000/api/ready`。因此未验收实例不经宿主发布端口或反代接流量；正常 `restart` policy 也不会替它恢复已断开的网络。

发布顺序固定为 `networks-isolated` → `app-started` → `ready-accepted` → `networks-reconnecting` → `network-published`。strict HTTP 200 + 原始字节 JSON `{"ok":true}` 且最终身份复核通过后，脚本**先持久写 `ready-accepted`，再做任何 network connect**；随后只用 Docker CLI 按 exact NetworkID 重连并重放 aliases，复核 NetworkID/name/aliases 集合。运行态 endpoint MAC 是 Docker 的动态属性，不捕获、不重放、不比较。全部网络与身份复核通过后才写 `network-published`；这是允许已验收实例继续服务的唯一提交点。任一重连失败都会尽力撤回全部已见 endpoint；能确认完全撤回时停止 exact 容器并写 `publication-failed`，不能确认时保留 `ambiguous-publication`，两者都非零退出、保留 accepted 与控制锁且绝不打印恢复成功。最后释放 host-only 控制锁时，accepted 证据会先原子移到 0600 sibling handoff；handoff 同时携带 exact container ID 与固定的 Compose project/service 身份，使部分清理失败后的下一次 restore 仍能按标签枚举额外实例。unlink/rename/rmdir 任一步失败都保留可明确判定的 accepted 证据，而不会留下含义模糊的残锁。

- 🔴 **完整性校验在所有破坏性步骤之前**：文件头检查（`SQLite format 3`）挡不住**截断/页损坏**——实测截到 2048 字节的库文件头仍然完好，但 `quick_check` 报 malformed。校验不过就直接中止：app 没停、`app.db` 没动。校验借 app 镜像里的 node 起一次性只读容器，以 `file:...?immutable=1` 打开（不是单纯 `readOnly`：纯 `cp` 出来的快照保留 `journal_mode=wal`，只读打开也要在同目录建 `-wal`/`-shm`，挂 `:ro` 会报 "attempt to write a readonly database" 把好快照误判成坏的）。
- 🔴 **文件头只接受已知安全的 `1/1`**（与 quick_check 同一步，同样在破坏性步骤之前）：WAL 库的已提交数据可能**只存在于配套的 `-wal` 里**，单独还原主文件会静默丢一截——而它结构完好、`quick_check` 返回 ok、`/api/ready` 也过，运维不会察觉（实测：源库 150 行，裸 `cp` 主文件还原出来只有 100 行）。判据是**文件头 offset 18/19**：`1/1`＝已知安全的 journal 单文件格式（`VACUUM INTO` 的产物）；`2/2`＝WAL 模式；`0/0`、混合值或其他未知值也一律 fail-closed。不能用 `PRAGMA journal_mode` 代替——`immutable=1` 打开时 PRAGMA 对两种快照都报 `delete`，照它判等于没判。
  - `data/backups/backup-*.db`（`npm run backup` 与 worker 每日备份的产物）都是 `VACUUM INTO` 出来的，正常运维路径不受影响。
  - **已知误拒**：干净关闭的 WAL 库内容其实是完整的，但磁盘上与「活动库裸 cp」无法区分，故一并拒绝（宁可误拒也不静默丢数据）。触发时脚本会打印把它转成一致性快照的确切命令。
- 🔴 **现场留存走 `VACUUM INTO`（借 app 镜像里的 node 起一次性容器），不是 `cp`**：`stop` 发的 SIGTERM 不做 WAL checkpoint，最后一段已提交数据只在 `app.db-wal` 里；裸拷主文件会丢这段，而脚本下一步就删 `-wal`——想反悔时回滚点已残缺且不可挽回。留存失败即 **fail-closed 中止**（不动 `app.db`），没有回滚点就不做破坏性还原。
- 🔴 **用 `pre-restore.db` 本身当恢复源是安全的**：脚本在停 app、重建 `pre-restore.db` 之前，已经把原恢复源固化并校验到 app 不可见的 host-only 副本；停机后再生成并二次核验同文件系统 stage，所以现场留存覆盖原文件不会影响最终还原内容。
- 🔴 **EXIT / SIGINT / SIGTERM 收尾不会混库**：trap 在精确 stop 前安装；最终 `mv` 前先创建 `replace-armed`，再以私有 stage 是否仍存在判断原子 rename 是否成功，因此不存在“库已替换但下一行 shell 状态尚未记录”的进程级信号窗口。未替换时保留当前库自己的 WAL（其中可能有唯一一份已提交数据），且只在 exact 身份仍一致、容器在 restore 开始前本来运行时才重启；原本停止或刚 `create` 的停止态容器保持停止。已替换时先安全清旧 WAL/SHM，再把 `replace-armed` 原子推进为 `sidecars-clean`。从 DB 替换到 `ready-accepted` 之间，任一错误、SIGINT 或 SIGTERM 都会停止实例并保留锁；新库自己产生的 WAL/SHM 不会被重复删除。SIGINT / SIGTERM 分别以 130 / 143 退出。
- 🔴 **并发与进程级硬中断 fail closed**：host-only control lock 负责同一 `DATA_DIR` 的全过程互斥，public stage 只在停机换库期存在。Linux 生产宿主把 owner 严格记录为 `v2 linux-proc <boot_id> <starttime_ticks>`：`boot_id` 与 `/proc/<pid>/stat` field 22 都通过现有 root/`SUDO` 路径读取，不再用调用者 UID 的 `kill -0` 猜存活。残锁判断显式分三态：PID + boot ID + start ticks 全匹配才是 `alive+matching`；boot ID 变化、同 PID start ticks 不同，或同一 root/`SUDO`/直接读取通道能严格枚举 `/proc` PID 集（含 PID 1）且确认目标缺席，才是 `definitely stale`；格式损坏、EPERM、`/proc`/sudo 不可读、枚举不完整或其他无法确认情况一律是 `unknown`。只有 `definitely stale` 才允许下面的 stop/断网收口；`alive` 与 `unknown` 都以 4 阻断、保留原锁/accepted 证据且不碰容器或网络。唯一独立的终态路径是发布成功后已原子形成 0600 accepted handoff、且 owner 元数据已按释放协议清除：它不再代表待判断的活跃 owner，后续只保留 trusted A 并收口额外候选。Darwin Docker Desktop 仅保留版本化的 UID + `ps lstart` 校验回退（同样经 `SUDO`）；其他非 Linux/Darwin 宿主在建锁、停机前失败，不能把“不支持 `/proc`”当 owner 已死。SIGKILL 后根据 host-only 阶段收口：
  - `app-started` 但无 `ready-accepted`：实例原本应保持无网络；下一次 restore 先读取锁内 exact ID，精确 stop 并确认无流量网络，再保留锁、退出 4 交人工处理。
  - 有 `ready-accepted` 但无 `network-published`：无论仍未重连、部分重连，还是重连已生效但来不及写下一阶段，内容都已验收但发布尚未提交；下一次 restore 会精确停止并撤回可见 endpoint，保留 accepted、当前阶段以及已有的 `publication-failed` / `ambiguous-publication` 证据。
  - 有 matching `ready-accepted` + `network-published`，或锁释放失败留下携带 exact ID/project/service 的 0600 accepted handoff：实例已验收并发布，不自动反向停机；残锁明确表示只差释放/人工核对。
  - 捕获 ID 消失、Compose 指针漂移或出现额外同 service 容器时，脚本按锁内/accepted handoff 的 exact ID 与固定 project/service/nononeoff 标签枚举，先停止能精确确认的未发布实例，再 fail-closed；绝不接受替代容器的 readiness。若 Docker 标签枚举或 Compose 当前指针查询本身失败，脚本不会把空结果当成“没有额外实例”，而会保留 `ambiguous-publication` 与状态锁。
  - 这项保证覆盖 restore owner 进程的 SIGKILL 与正常 restart policy，**不承诺**在 restore 已被杀后继续对抗另一个具 Docker 管理权限的人为 `recreate` / `network connect`。方案不新增常驻服务、不改反代/Compose 拓扑、不挂 Docker socket，也不引入新的 Docker-admin 主体。
  - ⚠️ **这不是宿主断电一致性承诺**：脚本没有对 marker、rename、sidecar unlink 做 `fsync` 屏障，SIGKILL 回归也只能证明进程级硬中断，不能证明掉电后的磁盘持久顺序。若 restore 期间宿主掉电/强制重启，无论锁是否仍可见，都先保持 app 停止，人工核对 `app.db`、`app.db-wal`/`app.db-shm` 与锁目录后再启动；不能只凭 marker 存在性自动判断。

- 🔴 **分叉守卫**：若 `data/.upgrade-in-progress` 存在（＝上次升级没走完），脚本**拒绝执行**并打印指引，退出码 3。先把当前安全的 `restore.sh` 单独复制到 checkout 外，再停 app、退回旧代码/镜像、`docker compose build app`（使用镜像 tag 的部署则 `pull app`）、`docker compose create --force-recreate app` 重建为**停止态**，最后用保留脚本带 `--after-image-rollback` 恢复。数据库恢复前禁止 `up`/`start`，否则旧服务会先运行 entrypoint 并可能写入中间 schema。
- 校验用 `/api/ready`（不是 `/api/health`）：liveness 通过只说明进程活着；restore 仅接受捕获容器 loopback 的 HTTP status **严格等于 200** 且响应 JSON **`ok === true`**。body 先写调用者侧 0600 `mktemp`，再经提权 `install -m 600` 放入 host-only control 并按原始字节解析，不经过会吞掉 NUL 的 shell 变量，也不要求普通调用者直接写 root-owned 控制目录。默认最多 60s（`READY_TIMEOUT` 可覆盖），使用绝对 deadline 并把每轮 probe/sleep 钳到剩余时间；302、其他 2xx、`ok:false`、空响应、NUL、额外内容或畸形 JSON 都会在 deadline 后失败、再次停机并保留 restore 状态。readiness 本身还会验证常驻连接、`DB_PATH` 当前 dev/inode 是否仍是启动时文件、磁盘新只读连接，以及两侧 schema 是否都与镜像匹配。
- 环境变量：`SUDO=`（macOS Docker Desktop，或宿主 UID 与容器 uid1000 明确隔离时可跳过；Linux uid1000 调用者必须保留 sudo/root；跨 UID owner 的 `/proc` 指纹确认也依赖这条提权路径）、`DATA_DIR`、`BACKUP_DIR`、`APP_URL`（仅用于超时后的宿主侧排障提示）、`READY_TIMEOUT`（默认 60，十进制 `1..86400`）。timeout、owner 指纹能力与同 UID 隔离条件都在停机/DB 写入前校验。
  - `BACKUP_DIR` 可自由改到任意路径（含 `data/` 之外）：脚本用显式 `-v` 把它挂进一次性容器，不依赖 compose 里那条 `./data:/app/data`。
  - 🔴 `DATA_DIR` **必须与 Compose 中绑到 `/app/data` 的唯一宿主 bind source 指向同一实体目录**（默认是 `./data:/app/data`），且捕获容器的实际 `/app/data` 挂载必须一致。脚本持续调用 `docker compose config --format json app`、`docker compose ps --all -q app` 与只读 `docker inspect` 核对；无容器时允许按已核验配置 `create app` 为停止态，多个容器、实际挂载缺失/歧义/named volume、旧容器与 Compose 不一致、额外 bind 暴露 control sibling，或恢复过程中 ID/source/image/dev/inode 漂移都 fail-closed。相对/绝对路径或 symlink 最终落到同一目录可通过，后续写入固定到已验证的物理绝对路径。
  - 🔴 网络隔离/恢复拒绝静态 IPv4/IPv6、link-local、`interface_name`、Compose 显式 MAC、driver opts、links 或非零网关优先级；这些配置不能由本方案可靠重放。普通动态 endpoint MAC 不作为身份，只固化并复核 NetworkID/name/aliases。停止态容器的 Compose config hash 陈旧同样在停机前拒绝。
- 退出码：0 仅表示 strict readiness、exact 身份与网络发布均通过，且状态锁已释放 / 1 快照无效（不存在／非 SQLite／未过 `quick_check`／header 18/19 不是 `1/1`）、Compose/容器身份无法确认、隔离/重连/sidecar/状态锁清理失败、readiness 超时或未接受 / 2 用法错（含非法 `READY_TIMEOUT`、非默认 `DB_PATH` 与「快照就是当前库本身」）/ 3 被升级标记拒绝 / 4 已有并发或异常中断的 restore 状态锁 / 130 收到 SIGINT / 143 收到 SIGTERM。`network-published` 前的非成功退出默认停止/隔离 app 并保留 host-only 状态；已写 `network-published` 但锁释放失败则保留 0600 accepted handoff，不反向停掉已验收实例。

演练完数据核对无误后，删掉 `data/backups/pre-restore.db` 即可（它不占轮转名额，但会一直留着）。

#### 脚本不可用或布局不受支持时：保持 fail-closed

不要维护第二套裸 `cp/install/rm/start` 手工配方。那条路径会绕过 header `1/1`、`quick_check`、私有 stage、互斥锁、信号 trap 与“未替换时保留旧 WAL / 已替换时先清 sidecar 再启动”的状态机，很容易把恢复做成数据丢失或混库。

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
- 传 `data/backups/` 整目录，含 `preupgrade.db` / `pre-restore.db` 这些钉住的回滚点。
- 🔴 **故意不加 `--delete`**：本地按 `BACKUP_KEEP` 每天轮转，加了 `--delete` 会把本地的轮转删除传播到异机——异机副本就退化成本地的镜像，既拿不到更长的留存，本地误删/被入侵删库也会立刻同步过去。代价是**远端只增不减，需自行清理**，例如在远端配：

  ```bash
  # 远端 crontab：保留 90 天
  find /srv/xjm-backups -name 'backup-*.db' -mtime +90 -delete
  ```

- 宿主 crontab 示例（每天 03:20 同步一次；worker 的每日备份在当天首个 tick 就完成了）：

  ```bash
  20 3 * * * cd /opt/xiaojimao-hub && REMOTE=user@backup-host:/srv/xjm-backups ./scripts/sync-backups.sh >> /var/log/xjm-sync.log 2>&1
  ```

  > 环境变量：`BACKUP_DIR` 覆盖本地目录（默认 `data/backups`）。cron 里务必先 `cd` 到仓库根，或用绝对路径的 `BACKUP_DIR`。

从异机副本恢复：把快照 `scp` 回本机任意路径，然后照 §5.2 用 `./scripts/restore.sh <路径>` 即可（脚本不要求快照必须在 `data/backups/` 下）。

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

### 9.1 两个探针

| | `GET /api/health`（liveness） | `GET /api/ready`（readiness） |
|---|---|---|
| 判什么 | 进程活着 | 常驻连接可读 + `DB_PATH` 仍是启动时 dev/inode + fresh 磁盘连接可读 + 两侧 schema 版本 === 代码要求 |
| 响应 | 恒 `200 {"ok":true}` | `200 {"ok":true}` / `503 {"ok":false}` |
| 不通该做什么 | **重启容器** | **摘流量 + 告警，别重启** |
| 谁在用 | 镜像 `HEALTHCHECK`、反代存活判断 | 外部拨测、反代 upstream 摘除、恢复校验 |

两者都无鉴权、无副作用，响应体只有 `ok` 字段——不带版本/路径/配置/账号信息（§8）。不就绪的具体原因（schema 版本差多少等）只进服务端日志：`[ready] 未就绪：...`。

> readiness 不是全库 `quick_check`：它能发现路径被 unlink/换 inode、磁盘 schema 不可读或版本不匹配，但不承诺识别任意业务数据页损坏。完整快照校验仍由恢复流程里的 `PRAGMA quick_check` 承担。

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
docker compose exec app node scripts/backup.ts   # 手动备份
./scripts/restore.sh <快照路径>      # 从快照恢复（见 §5.2）
REMOTE=user@host:/path ./scripts/sync-backups.sh # 备份推异机（见 §5.3）
docker compose exec app date        # 核对时区
docker compose exec app id          # 核对非 root
docker compose down                 # 停并删容器（保留宿主 ./data）
curl -s http://127.0.0.1:3000/api/health   # liveness
curl -s http://127.0.0.1:3000/api/ready    # readiness（常驻/新连接、DB 文件身份、schema 版本）
```
