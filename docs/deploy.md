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

> **空版本行保护**：若日志报 `schema_version 表存在但无版本行，且已有业务表`，迁移器会在修改业务
> schema 前 fail-closed。这代表无法区分「旧版已跑过多少迁移」，不要盲填最新版本或反复重启。只有在确认
> `preupgrade.db` 确实早于该异常状态时才恢复它；首次检测到此状态时，entrypoint 可能刚把当前歧义库钉住为
> `preupgrade.db`，此时应找更早的已知正常备份，或复制数据库到离线环境核对实际 schema 后再补写正确版本。

> 升级前如需人工快照，见 §5 手动备份。回滚：停容器 → 用 §5 的恢复步骤还原到升级前的备份 → 起旧镜像。

---

## 5. 备份与恢复

### 5.1 备份机制

`scripts/backup.ts` 用 SQLite `VACUUM INTO` 产出 **WAL 安全的一致性单文件快照**（对源库只读、不打断在线写入），落到 `data/backups/backup-<时间戳>-<随机>.db`，并按 `BACKUP_KEEP`（默认 7）只保留最新 N 份。

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

脚本按顺序做：取得 `data/.restore-in-progress` 互斥锁 → 把源快照固化为锁目录内的私有 0600 stage → 对**同一 stage**做文件头、`PRAGMA quick_check` 与 WAL 模式拒收校验 → `docker compose stop app` → 现场 `app.db` 用 `VACUUM INTO` 存为 `data/backups/pre-restore.db`（单文件覆盖式，同 `preupgrade.db` 一样不进轮转集）→ 创建 `replace-armed` 状态并把已校验 stage 同文件系统原子 `mv` 为 `app.db` → 删旧库的 `-wal`/`-shm` 与 `.upgrade-in-progress` → `docker compose start app` → 轮询 `/api/ready` 最多 60s（可用 `READY_TIMEOUT` 调；每轮 curl 与 sleep 都按剩余秒数钳制）→ 释放状态锁。

- 🔴 **完整性校验在所有破坏性步骤之前**：文件头检查（`SQLite format 3`）挡不住**截断/页损坏**——实测截到 2048 字节的库文件头仍然完好，但 `quick_check` 报 malformed。校验不过就直接中止：app 没停、`app.db` 没动。校验借 app 镜像里的 node 起一次性只读容器，以 `file:...?immutable=1` 打开（不是单纯 `readOnly`：纯 `cp` 出来的快照保留 `journal_mode=wal`，只读打开也要在同目录建 `-wal`/`-shm`，挂 `:ro` 会报 "attempt to write a readonly database" 把好快照误判成坏的）。
- 🔴 **WAL 模式的快照一律拒收**（与 quick_check 同一步，同样在破坏性步骤之前）：WAL 库的已提交数据可能**只存在于配套的 `-wal` 里**，单独还原主文件会静默丢一截——而它结构完好、`quick_check` 返回 ok、`/api/ready` 也过，运维不会察觉（实测：源库 150 行，裸 `cp` 主文件还原出来只有 100 行）。判据是**文件头 offset 18/19**（`1/1`＝journal 模式，`VACUUM INTO` 的产物；`2/2`＝WAL 模式），不是 `PRAGMA journal_mode`——`immutable=1` 打开时 PRAGMA 对两种快照都报 `delete`，照它判等于没判。
  - `data/backups/backup-*.db`（`npm run backup` 与 worker 每日备份的产物）都是 `VACUUM INTO` 出来的，正常运维路径不受影响。
  - **已知误拒**：干净关闭的 WAL 库内容其实是完整的，但磁盘上与「活动库裸 cp」无法区分，故一并拒绝（宁可误拒也不静默丢数据）。触发时脚本会打印把它转成一致性快照的确切命令。
- 🔴 **现场留存走 `VACUUM INTO`（借 app 镜像里的 node 起一次性容器），不是 `cp`**：`stop` 发的 SIGTERM 不做 WAL checkpoint，最后一段已提交数据只在 `app.db-wal` 里；裸拷主文件会丢这段，而脚本下一步就删 `-wal`——想反悔时回滚点已残缺且不可挽回。留存失败即 **fail-closed 中止**（不动 `app.db`），没有回滚点就不做破坏性还原。
- 🔴 **用 `pre-restore.db` 本身当恢复源是安全的**：脚本在停 app、重建 `pre-restore.db` 之前，已经把原恢复源固化并校验到私有 stage；所以现场留存覆盖原文件不会影响最终还原内容，也不会静默丢掉唯一回滚点。
- 🔴 **EXIT / SIGINT / SIGTERM 收尾不会混库**：trap 在 `stop` 前安装；最终 `mv` 前先创建 `replace-armed`，再以私有 stage 是否仍存在判断原子 rename 是否已经成功，因此不存在“库已替换但下一行状态尚未记录”的进程级信号窗口。未替换时保留当前库自己的 WAL（其中可能有唯一一份已提交数据）；已替换时必须先删旧 WAL/SHM 并撤销 armed 才允许重启。清理失败会明确报错、保持 app 停止并保留状态锁，不会带着陈旧 sidecar 启动。armed 撤销后，readiness 超时等后续 EXIT 不会再误删新库运行中产生的 WAL/SHM。SIGINT / SIGTERM 分别以 130 / 143 退出，并在安全条件满足时幂等尝试重启 app。
- 🔴 **并发与进程级硬中断 fail closed**：同一 `DATA_DIR` 同时只允许一个 restore。若上次被 SIGKILL 或在不安全阶段失败，当前文件系统可见的 `data/.restore-in-progress` 会让下次以退出码 4 拒绝；其中 `replace-armed` 与 `snapshot.db` 的存在性用于判断“已武装未替换”还是“可能已替换待清 sidecar”。先保持 app 停止、确认现场并按脚本提示人工处置，禁止直接删锁后启动。
  - ⚠️ **这不是宿主断电一致性承诺**：脚本没有对 marker、rename、sidecar unlink 做 `fsync` 屏障，SIGKILL 回归也只能证明进程级硬中断，不能证明掉电后的磁盘持久顺序。若 restore 期间宿主掉电/强制重启，无论锁是否仍可见，都先保持 app 停止，人工核对 `app.db`、`app.db-wal`/`app.db-shm` 与锁目录后再启动；不能只凭 marker 存在性自动判断。

- 🔴 **分叉守卫**：若 `data/.upgrade-in-progress` 存在（＝上次升级没走完），脚本**拒绝执行**并打印指引，退出码 3。必须先把镜像/代码退回旧版本、`docker compose up -d --build` 重建容器，再带 `--after-image-rollback` 重跑——原因见下方手工步骤里的 ⚠️ 分叉说明。
- 校验用 `/api/ready`（不是 `/api/health`）：liveness 通过只说明进程活着，readiness 才验证「库能读 + schema 版本与镜像匹配」——还原错版本的快照就卡在这一步。
- 环境变量：`SUDO=`（已是 uid1000 / macOS Docker Desktop 时跳过 sudo）、`DATA_DIR`、`BACKUP_DIR`、`APP_URL`、`READY_TIMEOUT`（等 readiness 的秒数上限，默认 60）。不能提权时自动省掉属主移交（只设权限 600）——Docker Desktop 会自动映射 uid，本就不需要 chown。
  - `BACKUP_DIR` 可自由改到任意路径（含 `data/` 之外）：脚本用显式 `-v` 把它挂进一次性容器，不依赖 compose 里那条 `./data:/app/data`。
  - 🔴 `DATA_DIR` **必须与 `docker-compose.yml` 里绑到 `/app/data` 的宿主路径一致**（默认那条是 `./data:/app/data`）：脚本按它定位要还原的库文件，容器按 compose 那条绑定定位它实际读的库；两者指的不是同一个目录时，还原的就是个 app 根本不读的文件。改了 compose 的绑定源要同步改这个。
- 退出码：0 成功 / 1 快照无效（不存在／非 SQLite／未过 `quick_check`／是 WAL 模式主文件）、路径无法解析、sidecar/状态锁安全清理失败或校验超时 / 2 用法错（含「快照就是当前库本身」）/ 3 被升级标记拒绝 / 4 已有并发或异常中断的 restore 状态锁 / 130 收到 SIGINT / 143 收到 SIGTERM。

演练完数据核对无误后，删掉 `data/backups/pre-restore.db` 即可（它不占轮转名额，但会一直留着）。

#### 后备：手工步骤（脚本不可用、或需要逐步观察时）

> 操作账号非 uid1000 时，下面直接读写 `./data`（0700，属主 1000）的命令都需 `sudo`；还原用 `install` 一步把 `app.db` 设成 **属主 1000 + 权限 600**（`cp` 覆盖已存在文件会保留目标原 mode，老部署那份 0644 不会收敛，且属主也要还原），否则容器起来写不了库、或库权限倒退到 0644。

```bash
# 1) 先做一次备份，拿到一份快照文件名
docker compose exec app node scripts/backup.ts
sudo ls data/backups/                # 记下 backup-XXXX.db

# 2) 停服务（释放对 app.db 的写锁）
docker compose stop app

# 3) 备份现场后替换（-wal/-shm 是 WAL 副本，恢复整库快照时必须一并删除；
#    .upgrade-in-progress 也要清——手动还原=人为终结升级链，不清则下次真升级会因「标记指向的旧快照仍在」被误判、跳过备份）
# 🔴 存现场必须 VACUUM INTO，别用 cp：stop 发的 SIGTERM 不做 checkpoint，最后一段已提交数据只在 app.db-wal 里，
#    裸 cp 只拷主文件会丢这段，而下一条命令就把 -wal 删了——想反悔时回滚点已残缺且不可挽回。
docker compose run --rm --no-deps --entrypoint node app -e \
  'const {DatabaseSync}=require("node:sqlite");const s=new DatabaseSync("/app/data/app.db");
   try{s.exec("PRAGMA busy_timeout=5000");s.prepare("VACUUM INTO ?").run("/app/data/backups/app.db.broken.bak")}finally{s.close()}'
sudo chmod 600 data/backups/app.db.broken.bak   # run 覆盖了 entrypoint，那条 umask 077 不生效
# 还原源：日常回滚用某份 backup-XXXX.db；若还原的是「升级失败现场」，升级前快照就是 data/backups/preupgrade.db（钉住不轮转、即最近一次升级前的库）
sudo install -o 1000 -g 1000 -m 600 data/backups/backup-XXXX.db data/app.db   # 一步 覆盖还原 + 属主 uid1000 + 权限 600；不用 cp（覆盖会保留目标原 mode，老部署 0644 收不紧、属主也不还原）
sudo rm -f data/app.db-wal data/app.db-shm
sudo rm -f data/.upgrade-in-progress

# 4) 起服务，校验
#    ⚠️ 分叉——还原的若是「升级失败现场」（用了 preupgrade.db，且本次升级的新镜像跑挂了），不要用 start：
#       新镜像 entrypoint 见 schema 落后，会拿刚还原的旧库重跑同一个失败迁移，回滚白做。须先把代码/镜像退回旧版本
#       （git checkout <旧提交/tag>，或改 compose 切回旧镜像 tag），再 `docker compose up -d --build` 重建容器——
#       旧代码的 LATEST_VERSION 与旧库版本一致，schema-check 过、不再迁移，干净起来。
#    日常演练 / 回滚到某份历史快照（镜像没换）才用下面这条：
docker compose start app
docker compose logs -f app           # [migrate] 完成、schema 版本正常
curl -s http://127.0.0.1:3000/api/health   # {"ok":true}（进程活着）
curl -s http://127.0.0.1:3000/api/ready    # {"ok":true}（库可读 + schema 版本匹配 ← 恢复成功的判据）
```

数据核对无误后删掉 `data/backups/app.db.broken.bak`。

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
| 判什么 | 进程活着 | 库能读 + schema 版本 === 代码要求 |
| 响应 | 恒 `200 {"ok":true}` | `200 {"ok":true}` / `503 {"ok":false}` |
| 不通该做什么 | **重启容器** | **摘流量 + 告警，别重启** |
| 谁在用 | 镜像 `HEALTHCHECK`、反代存活判断 | 外部拨测、反代 upstream 摘除、恢复校验 |

两者都无鉴权、无副作用，响应体只有 `ok` 字段——不带版本/路径/配置/账号信息（§8）。不就绪的具体原因（schema 版本差多少等）只进服务端日志：`[ready] 未就绪：...`。

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

**② 外部拨测 `/api/ready`（catch「服务挂了 / 库坏了 / schema 不匹配」）**

在 Uptime Kuma 建 HTTP(s) 监控指向 `https://<你的域名>/api/ready`，Accepted Status Codes 保持 `200-299`——未就绪时返回 503 即触发告警。间隔 60s 足够。

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
curl -s http://127.0.0.1:3000/api/ready    # readiness（库 + schema 版本）
```
