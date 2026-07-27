#!/bin/sh
# =============================================================================
# 从快照恢复数据库（P6-R2，docs/deploy.md §5.2 手工步骤的脚本化）
#
# **宿主侧运行**（在 docker-compose.yml 所在目录，即仓库根）。流程：
#   停 app → 现场 app.db 存为 backups/pre-restore.db → install 快照为 app.db（0600 / uid1000）
#   → 删 -wal/-shm/.upgrade-in-progress → 起 app → 校验 /api/health 与 /api/ready
#
# 用法：
#   ./scripts/restore.sh data/backups/backup-2026-07-26T01-00-00-a1b2c3.db
#   ./scripts/restore.sh --after-image-rollback data/backups/preupgrade.db
#
# 环境变量：
#   SUDO=        操作账号已是 uid1000 / macOS Docker Desktop 时置空跳过 sudo（默认用 sudo）
#   DATA_DIR     宿主数据目录，默认 data。🔴 **必须与 docker-compose.yml 里绑到 /app/data 的宿主
#                路径一致**（默认那条是 `./data:/app/data`）：脚本按它定位要还原的库文件，容器按
#                compose 那条绑定定位它实际读的库——两者必须指同一个目录，否则还原了个 app 根本
#                不读的文件。改了 compose 的绑定源就同步改这个。
#   BACKUP_DIR   备份目录，默认 $DATA_DIR/backups
#   APP_URL      校验地址，默认 http://127.0.0.1:3000
# =============================================================================
set -eu

DATA_DIR="${DATA_DIR:-data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
APP_URL="${APP_URL:-http://127.0.0.1:3000}"
MARKER="$DATA_DIR/.upgrade-in-progress"
DB="$DATA_DIR/app.db"

# 🔴 P6-R2 复审三轮第 1 条 + R6①：DB_PATH 覆盖 fail-closed 守卫（与 lib/worker.ts backupPaths() 对齐）
#
# backupPaths 尊重 DB_PATH（默认 `data/app.db`）——即备份的是**用户实际指定的库**。但 restore.sh
# 此前**硬编码** `DB="$DATA_DIR/app.db"`，在 DB_PATH≠默认值时：① 运行会静默恢复到错误位置（宿主
# 实际库不在 `data/app.db`，脚本却往那里写）；② 下面的路径归一 `realpath` 拿着错误路径去算，若恰好
# `data/app.db` 不存在 → `realpath` 报错脚本崩；③ 若 `data/app.db` 存在且**不同于实际库**、归一
# 通过，那恢复快照后重启容器会启动一个**全新**空库（DB_PATH 指向的那个位置没被改）＝静默数据丢失。
#
# 🔴 **不做路径解析大工程**：解析 DB_PATH 要处理符号链接、相对路径、cwd 不定、可能不存在、多级 ../ 等
#    （backupDb 用的是 `db.ts` 里已 open 的连接，应用层传给它的 dbPath 早已是 DatabaseSync 吃下去的
#    **whatever works**，Node 处理了所有复杂形式）。脚本层**做不到**以同样逻辑归一，且即便写出来也是
#    一堆未经测试的 corner-case 陷阱。
#
# 🔴 Fail-closed 守卫（R6① 增强 + R4-P1① 修复）：除了已 export 的 DB_PATH，还要从**容器配置读
#    实际生效值**（codex R5 指出：DB_PATH 仅在 .env 或 Compose 配置、宿主未 export 时，R3① 守卫
#    会被跳过；R6 codex 指出：R5 修复用的 `ps | grep Up` 只能检测运行态容器，**容器停机/崩溃
#    循环——正是恢复场景常态**时无法读取配置，守卫漏洞仍在）。
#
#    R4-P1① 修复：改用 `docker compose config app` 静态解析容器配置（展开 env_file、插值
#    environment 里的 `${TZ:-...}` 等、合并多来源），无论容器运行/停止/根本不存在都能解出 DB_PATH
#    实际生效值，且不依赖 daemon（纯本地文件解析）—— config 比 exec/ps 稳定、比自己手工解析
#    .env/.yml 安全（不会踩 YAML 引号/插值/多来源合并的坑）。
#
#    ⚠️ 解析失败时（.env 缺失、compose 文件损坏）config 退 1 → $(…) 取空、下面 [ -n ... ] 判否、
#       CONTAINER_DB_PATH 守卫不拦、**只看宿主那条**。这是安全的：config 失败⊆run/exec 全失败
#      （实测缺 .env 时 config rc=1、run rc=1、stop rc=0），脚本到 node_with_snapshot / node_in_data
#       阶段一定挂，不会悄悄跳过守卫并恢复到错误位置。唯一丢失的是「容器停机且 config 解不出时
#       的错误提示质量」（报 docker run 的通用错而非 DB_PATH 专属提示），可接受。
CONTAINER_DB_PATH=$(docker compose config app 2>/dev/null \
  | grep -E '^ +DB_PATH:' \
  | head -1 \
  | sed 's/^[^:]*:[[:space:]]*//' \
  | sed "s/^['\"]//; s/['\"]$//" \
  || echo "")

# 🔴 R6-P1②（codex R5 终审）：非默认 DB_PATH 的手工恢复指引。
#
#    修复前两处守卫都写「直接 cp 快照文件到实际库路径」——这条指引本身会毁数据：
#      ① 库跑 WAL 模式，app 还在跑时 cp 拷的是**撕裂的中间态**（主文件与 -wal 不一致）；
#      ② 即便先停了 app，遗留的 `-wal`/`-shm` 属于**旧库**，新库一起来 SQLite 会把这些陈旧页
#         当成自己的未提交事务重放 → 库直接 malformed，或悄悄混入旧数据；
#      ③ cp 出来的文件权限/属主随操作账号（root:root 0644 之类），容器以 uid1000 跑 → 起来
#         就是 "unable to open database file"，或世界可读地暴露全库。
#    故这里输出**与脚本自身完全同款**的安全序列：停 app → 现场留存 → 原子就位 → 清 WAL 残留
#    → 恢复权限属主 → 起 app → 校验。绝不给裸 cp。
#    ⚠️ 下面步骤 b 的路径是容器内路径（docker run 里跑 node），c/d/e 的路径是**宿主**路径——
#       两者未必一致（DB_PATH=/srv/xjm/db 在容器里用，宿主侧可能是 /mnt/volumes/xjm/db 挂进去）。
#       运维需自行换算：容器路径照抄守卫输出的那条（已从容器配置读出），宿主路径按自己绑定的
#       volume 源目录填（compose 的 `-v <host>:<container>`左边）。文档不可能自动算这个（没法从
#       容器配置反推宿主真实挂载点——overlay/tmpfs/命名卷都不是文件系统路径），只提供模板。
print_manual_steps() {
  _target="$1"
  cat >&2 <<EOF
     ⚠️ 下面步骤 b 是容器内路径（${_target}），c/d/e 是宿主路径——按你的 volume 绑定换算。
     a) 停 app（释放写锁，务必先做）：
          docker compose stop app
     b) 留存当前现场（🔴 用 VACUUM INTO，不能 cp——WAL 里的已提交数据 cp 不到）：
          docker compose run --rm --no-deps -T --entrypoint node app -e \\
            'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("${_target}");d.exec("VACUUM INTO \"${_target}.pre-restore\"");d.close()'
     c) 原子就位（<宿主路径>，非容器路径；先写临时名再 mv，中途被杀不会留半截库冒充好库）：
          cp -- <快照路径> '<宿主路径>.tmp' && mv -- '<宿主路径>.tmp' '<宿主路径>'
     d) 🔴 删掉旧库的 WAL 残留（<宿主路径>；不删则新库启动时会重放陈旧页 → malformed 或混入旧数据）：
          rm -f '<宿主路径>-wal' '<宿主路径>-shm' '${MARKER}'
     e) 恢复权限与属主（<宿主路径>；容器以 uid1000 跑，属主不对会 unable to open database file）：
          sudo chown 1000:1000 '<宿主路径>' && sudo chmod 600 '<宿主路径>'
     f) 起 app 并校验：
          docker compose start app
          curl -fsS --connect-timeout 3 --max-time 5 ${APP_URL}/api/ready
EOF
}

if [ -n "${DB_PATH:-}" ] && [ "$DB_PATH" != "data/app.db" ]; then
  echo "❌ restore.sh 不支持非默认 DB_PATH（宿主侧检测到 DB_PATH='$DB_PATH'）。" >&2
  echo "" >&2
  echo "本脚本硬编码假设库位于 data/app.db（与 docker-compose.yml / Dockerfile 默认一致）。" >&2
  echo "若运维环境已用 DB_PATH 覆盖库位置，请采用以下方案之一：" >&2
  echo "  1. 临时恢复默认：unset DB_PATH 后执行本脚本；或" >&2
  echo "  2. 手动恢复（照下面的顺序做，别直接 cp 到活库上）：" >&2
  print_manual_steps "$DB_PATH"
  echo "" >&2
  echo "🔴 不可忽略本错误：强行执行会把快照恢复到错误位置，导致数据丢失。" >&2
  exit 2
fi

if [ -n "$CONTAINER_DB_PATH" ] && [ "$CONTAINER_DB_PATH" != "data/app.db" ]; then
  echo "❌ restore.sh 不支持非默认 DB_PATH（容器内检测到 DB_PATH='$CONTAINER_DB_PATH'）。" >&2
  echo "" >&2
  echo "app 容器配置了非默认数据库路径（来自 .env 或 docker-compose.yml 的 environment）。" >&2
  echo "本脚本硬编码假设库位于 data/app.db，继续执行会把快照恢复到错误位置。" >&2
  echo "" >&2
  echo "请采用以下方案之一：" >&2
  echo "  1. 清空 .env / docker-compose.yml 里的 DB_PATH 配置，重新部署后执行本脚本；或" >&2
  echo "  2. 手动恢复（照下面的顺序做，别直接 cp 到活库上）：" >&2
  print_manual_steps "$CONTAINER_DB_PATH"
  echo "" >&2
  echo "🔴 不可忽略本错误：强行执行会导致数据丢失。" >&2
  exit 2
fi

# 路径归一：docker -v 只认绝对路径（相对路径会被当成**命名卷**静默建一个空卷，
# 于是容器看到的是空目录、脚本却以为在读宿主的库）。同时用于判断两个路径是否指向同一文件。
#
# 🔴 必须 fail-closed：`cd` 失败时 `$(...)` 只是取到空串，拼出来的会是 `/pre-restore.db` 这种
#    **看着像绝对路径的垃圾**——拿它当 `-v` 源就等于把宿主根目录 `/` 挂进容器。而这不是理论情形：
#    `data/backups` 按 §2 是 0700 且属主 uid1000，操作账号不是 1000 时 `cd` 必然 Permission denied。
#    故显式判空并中止。
# 🔴 R4-P1②：路径归一时解符号链接，否则快照是 pre-restore.db 的符号链接时守卫失效。
#
# 必修① 的核心防御是「快照==pre-restore.db 时跳过现场留存（不去覆盖快照本身）」，用 abspath 归一
# 后的路径相等性判断。修复前 abspath 只做 `cd $(dirname) && pwd` + basename 拼接，碰到符号链接
# 时不追踪——若快照是指向 pre-restore.db 的**符号链接**（如 `ln -s pre-restore.db snap.db` 后
# 给脚本传 snap.db），abspath 算出的路径分别是 `.../snap.db` 与 `.../pre-restore.db`，**不相等**，
# 守卫放行，现场留存段用当前 app.db **覆盖**掉 pre-restore.db 真身 → 二次反悔回滚点静默丢失。
#
# R4-P1② 修复：`cd -P` 追踪目录段的符号链接，再对 basename 段**循环** readlink 直到不再是链接。
# 必须是循环而不是解一层：`snap.db -> mid.db -> pre-restore.db` 这种链只解一层会停在 mid.db，
# 守卫照样放行。readlink 给相对目标时按其所在目录解析；给绝对目标时直接接着走下一轮。
# 32 层上限用于兜住成环（`a -> b -> a`）——没有上限就是死循环，脚本挂在这里比误覆盖更糟。
# 断链/不存在：`-L` 在下一轮为假 → 直接返回已拼好的绝对路径（后续 head -c 15 / quick_check
# 会拒绝不存在/不可读的文件，不归 abspath 管）。
abspath() {
  _p="$1"
  _hops=0
  while :; do
    _d=$(cd -P -- "$(dirname -- "$_p")" 2>/dev/null && pwd) || _d=""
    if [ -z "$_d" ]; then
      echo "❌ 无法解析路径（目录不存在或无权进入）：$1" >&2
      echo "   $DATA_DIR 按 docs §2 是 0700/属主 uid1000；操作账号不是 1000 时请用 sudo 跑本脚本。" >&2
      exit 1
    fi
    _p="$_d/$(basename -- "$_p")"
    # 不是符号链接（含断链指向的不存在路径）→ 已归一到底，收工
    [ -L "$_p" ] || break
    _hops=$((_hops + 1))
    if [ "$_hops" -gt 32 ]; then
      echo "❌ 符号链接层级过深或成环，拒绝继续：$1" >&2
      exit 1
    fi
    _t=$(readlink -- "$_p" 2>/dev/null) || _t=""
    if [ -z "$_t" ]; then
      echo "❌ 无法读取符号链接目标：$_p" >&2
      exit 1
    fi
    case "$_t" in
      /*) _p="$_t" ;;
      *) _p="$_d/$_t" ;;
    esac
  done
  printf '%s\n' "$_p"
}

# 目录版：直接 cd 进目标目录本身。abspath 只验证**父目录**存在，用它解析目录会让
# 「目录不存在」蒙混过关，而 docker -v 遇到不存在的源路径会以 root 悄悄新建一个空目录
# ——容器于是读到空目录，脚本却以为在读宿主的库。挂载源必须走这个。
absdir() {
  _d=$(cd -- "$1" 2>/dev/null && pwd) || _d=""
  if [ -z "$_d" ]; then
    echo "❌ 目录不存在或无权进入：$1" >&2
    echo "   $DATA_DIR 按 docs §2 是 0700/属主 uid1000；操作账号不是 1000 时请用 sudo 跑本脚本。" >&2
    exit 1
  fi
  printf '%s\n' "$_d"
}

# 借 app 镜像里的 node 跑一段只读/备份 JS。本脚本本就依赖 docker compose（下面要 stop/start），
# 不是新依赖；用 run 而非 exec，是因为恢复常发生在容器已停/崩溃循环时，exec 那会儿连不上。
#
# 🔴 显式 `-v` 挂载，**不依赖 compose 里那条 `./data:/app/data`**：那条只绑默认路径，`BACKUP_DIR`
#    被改到别处时就对不上——脚本头与 docs §5.2 声称支持该覆盖项，此前却会把 pre-restore.db 写进
#    容器内的临时层、宿主看不见（P6-R2 复审第 5 条：别让文档承诺代码不支持的能力）。
#    容器内挂载点**写死**（/d、/b、/snapdir），宿主侧路径只经 -v 参数传入、绝不拼进 JS 源码：
#    含空格/引号/`$` 的宿主路径既不会造成 JS 语法错，也不会被当代码执行。
#    两个调用点的挂载数不同，故不做「可变参数」的通用封装——shell 里拼 -v 列表必须靠
#    unquoted 词拆分，那正好在含空格的宿主路径上断掉（本仓库路径就是中文目录）。写死两个函数最稳。

# 把 <宿主快照文件>本身挂成容器内的 /snap.db（ro），跑 JS。
# 挂**文件**而非所在目录：目录里可能还有别的库/密钥，没必要整个暴露给一次性容器。
#
# 🔴 R6-P2③（codex R5 终审）：这一步必须以 **root** 跑（`--user 0:0`）。
#
#    镜像里是 `USER node`（uid 1000）。Linux 的 bind-mount **保留宿主 uid/gid 与权限位**，不做
#    任何映射：运维用 root 从异机 scp/rsync 下来的快照通常是 `root:root 0600`（sync-backups.sh
#    的产物、docs §5.3 的异机备份都是这个形态），容器里的 uid1000 对它 **没有读权限** →
#    `new DatabaseSync` 直接 EACCES → 下面的 `||` 分支把一份**完全合法**的快照报成「截断/损坏」。
#    而这发生在「还没停 app」的阶段，表现是恢复流程根本起不了步：运维手里明明有好快照却被拒。
#
#    为什么这一步可以提权（三条一起成立，缺一不可）：
#      ① 纯只读——挂载带 `:ro`（内核层面禁写，容器内 root 也写不进去），JS 侧再叠
#         `?immutable=1` + `readOnly: true`，SQLite 连 -wal/-shm 都不建；
#      ② 只碰快照这一个**文件**，不挂 DATA_DIR、碰不到活库 app.db，跑挂了也不改变任何现场；
#      ③ 一次性容器（`--rm --no-deps`），跑完即销毁，不留下以 root 运行的长驻进程。
#    对比另一条路「先 stage 一份容器可读的副本」：那要在宿主上多复制一份**全库**（磁盘可能不够、
#    还得保证副本不世界可读且异常路径下也清理掉），比只读提权的风险面更大。故选 --user 0:0。
#
#    ⚠️ 只有这个函数提权。node_in_data 会**写** pre-restore.db，仍保持镜像默认的 uid1000
#       ——产物属主必须是 1000，容器起来才读得到（见下面 install 的 -o 1000 -g 1000）。
node_with_snapshot() {
  docker compose run --rm --no-deps -T \
    --user 0:0 \
    -v "$1:/snap.db:ro" \
    --entrypoint node app -e "$2"
}

# 挂 <宿主 DATA_DIR>→/d、<宿主 BACKUP_DIR>→/b，跑 JS。
node_in_data() {
  docker compose run --rm --no-deps -T \
    -v "$1:/d" \
    -v "$2:/b" \
    --entrypoint node app -e "$3"
}

# 非 uid1000 账号读写 ./data（0700、属主 1000）需要 sudo；已是 root 或显式 SUDO= 则不用。
if [ "$(id -u)" = "0" ]; then SUDO="${SUDO-}"; else SUDO="${SUDO-sudo}"; fi

# 属主移交（-o 1000 -g 1000）：容器以 uid1000 跑，宿主文件须归 1000，否则容器起来写不了库。
# 但**不能提权时 chown 必失败**——install 会中途报错、留下一个截断的目标文件。而这恰是
# macOS/Windows Docker Desktop 的常态（uid 自动映射、本就无需 chown，见 docs §2 的跳过注）。
# 故：能提权（root 或有 sudo）才带 -o/-g，否则只设权限位 600。
if [ -n "$SUDO" ] || [ "$(id -u)" = "0" ]; then
  OWN="-o 1000 -g 1000"
else
  OWN=""
fi

AFTER_ROLLBACK=0
SNAPSHOT=""
for arg in "$@"; do
  case "$arg" in
    --after-image-rollback) AFTER_ROLLBACK=1 ;;
    -*) echo "❌ 未知选项：$arg" >&2; exit 2 ;;
    *) SNAPSHOT="$arg" ;;
  esac
done

if [ -z "$SNAPSHOT" ]; then
  echo "用法：$0 [--after-image-rollback] <快照路径>" >&2
  echo "  日常回滚用 $BACKUP_DIR/backup-*.db；升级失败现场用 $BACKUP_DIR/preupgrade.db" >&2
  exit 2
fi

[ -f "$SNAPSHOT" ] || { echo "❌ 快照不存在：$SNAPSHOT" >&2; exit 1; }

# 快照必须是 SQLite 库文件——错传一个日志/空文件会把库换成垃圾且直到起服务才发现
if [ "$(head -c 15 "$SNAPSHOT" 2>/dev/null || true)" != "SQLite format 3" ]; then
  echo "❌ 不是 SQLite 库文件（缺 'SQLite format 3' 文件头）：$SNAPSHOT" >&2
  exit 1
fi

SNAPSHOT_ABS="$(abspath "$SNAPSHOT")"
DB_ABS="$(abspath "$DB")"

# 🔴 快照 == 目标库：还原「自己盖自己」没有意义，且下面 install 会因 same file 报错（exit 64）而
#    中止在半途（此时 app 已停、现场已存）。提前拒绝，给出清晰指引。
if [ "$SNAPSHOT_ABS" = "$DB_ABS" ]; then
  echo "❌ 快照就是当前库本身（${DB}），还原它没有意义。" >&2
  exit 2
fi

# 🔴 分叉守卫（docs §5.2）：标记在＝上次升级没走完。此时若直接 start，新镜像 entrypoint 见 schema
#    落后会拿刚还原的旧库重跑同一个失败迁移，回滚白做。必须先把镜像/代码退回旧版本、`up -d --build`
#    重建容器，再带 --after-image-rollback 跑本脚本。
if [ -f "$MARKER" ] && [ "$AFTER_ROLLBACK" -eq 0 ]; then
  cat >&2 <<EOF
🛑 检测到未完结的升级标记：$MARKER
   直接恢复会白做：新镜像启动时见 schema 落后，会拿还原后的旧库重跑同一个失败迁移。
   正确顺序：
     1) 把代码/镜像退回旧版本（git checkout <旧提交/tag>，或改 compose 切回旧镜像 tag）
     2) docker compose up -d --build        # 重建容器，旧代码与旧库版本一致、不再迁移
     3) $0 --after-image-rollback $SNAPSHOT
   （已确认完成第 1、2 步时，加 --after-image-rollback 继续。）
EOF
  exit 3
fi

echo "→ 恢复源：$SNAPSHOT"
echo "→ 目标库：$DB"

# 🔴 完整性校验（P6-R2 复审第 3 条）：`head -c 15` 只看文件头，一个**截断/损坏**的快照照样能过——
#    实测截到 2048 字节的库仍带 'SQLite format 3' 头，但 quick_check 抛 malformed。不校验就会
#    停服务、换库，直到 readiness 才发现，而那时现场已经被换掉了。故放在所有破坏性步骤之前。
#    只读打开（readOnly:true），绝不改动快照本身。
echo "→ 校验快照完整性（PRAGMA quick_check）"
# `immutable=1`（不是单纯 readOnly:true）：纯 cp 出来的快照会保留 journal_mode=wal，SQLite 打开时
# 即便只读也要在**同目录**建 -wal/-shm——挂 :ro 会直接报 "attempt to write a readonly database"，
# 把好快照误判成坏的。immutable 让 SQLite 完全跳过 WAL/锁机制，只读文件本身；实测仍能检出
# 截断（2048 字节）与页损坏（均抛 malformed），且不在宿主目录留任何副产物。
node_with_snapshot "$SNAPSHOT_ABS" '
  const { DatabaseSync } = require("node:sqlite")
  const d = new DatabaseSync("file:/snap.db?immutable=1", { readOnly: true })
  try {
    const r = d.prepare("PRAGMA quick_check").get()
    if (!r || r.quick_check !== "ok") {
      console.error("quick_check 未返回 ok：" + JSON.stringify(r))
      process.exit(1)
    }
  } finally {
    d.close()
  }
' || {
  echo "❌ 快照未通过完整性校验（截断/损坏）：$SNAPSHOT" >&2
  echo "   已中止，$DB 未被改动，app 也未停。换一份快照重试。" >&2
  exit 1
}

echo "→ 停 app（释放对 app.db 的写锁）"
docker compose stop app

# 🔴 退出陷阱（P6-R2 R3 总指挥发现）：stop 后任一步骤失败（VACUUM/install/start/readiness 超时）
#    时 set -e 直接退出 → 服务保持停止状态。库虽保住（fail-closed）但 app 没起来 → 不必要停机。
#    trap 兜底：无论脚本怎么退出（正常/报错/kill），EXIT 时都试图重启 app，确保「最坏情况下服务
#    也能恢复到还原前的运行态」——readiness 可能不通过（换错版本快照），但至少进程活着、能排查。
trap 'docker compose start app >/dev/null 2>&1 || true' EXIT

# 现场先存一份：单文件覆盖式，仿 preupgrade.db 的钉住模式——文件名不匹配 ^backup-.*\.db$，
# 故不进 BACKUP_KEEP 轮转集，也不会被 latestBackupDay 误当成「今天的日常备份」。
PRE_RESTORE="$BACKUP_DIR/pre-restore.db"
RESTORE_SRC="$SNAPSHOT"   # 实际用来还原的路径，可能被下面改指到副本
if [ -f "$DB" ]; then
  echo "→ 存下当前现场：${PRE_RESTORE}（覆盖上一次的同名文件）"
  # shellcheck disable=SC2086  # $OWN 需按词拆分成 -o 1000 -g 1000（或空）
  $SUDO install -d $OWN -m 700 "$BACKUP_DIR"

  # 🔴 自毁防护（P6-R2 复审必修 1）：用户跑过一次 restore 后想拿 pre-restore.db 回到最初状态，
  #    是最自然的二次反悔路径。但下面这段会用**当前 app.db** 重建同名文件——$SNAPSHOT 在被
  #    读取前就被覆盖，还原出来的是当前坏状态，且脚本一路 ✅、readiness 也过（库合法、版本也对），
  #    用户不会发现回滚失败，而唯一回滚点已经没了。故先把它拷到临时副本，从副本还原。
  #    ⚠️ 先算好再比：`if [ x = "$(abspath ...)" ]` 里 `set -e` 不生效，abspath 万一失败会取到空串、
  #       比较悄悄不成立 → 守卫静默失效，正好回到本条要修的那个数据丢失场景。故提到 if 外面。
  PRE_RESTORE_ABS="$(abspath "$PRE_RESTORE")"
  if [ "$SNAPSHOT_ABS" = "$PRE_RESTORE_ABS" ]; then
    RESTORE_SRC="$BACKUP_DIR/.restore-src.db"
    echo "   ⚠️ 恢复源就是 ${PRE_RESTORE}，先复制一份到 ${RESTORE_SRC} 再用（否则会被本步覆盖）"
    $SUDO rm -f "$RESTORE_SRC"
    $SUDO cp -- "$SNAPSHOT" "$RESTORE_SRC"   # 快照是静态文件（非活动库），cp 即可，无 WAL 问题
    $SUDO chmod 600 "$RESTORE_SRC"
  fi

  # 🔴 必须 VACUUM INTO，绝不能 cp/install：库跑 WAL 模式，`docker compose stop` 发 SIGTERM 后进程
  #    不做 checkpoint 就退出，最后一段已提交数据只躺在 app.db-wal 里。裸拷主文件会丢这段，而下面
  #    紧接着 `rm -f "$DB-wal"` 会把唯一副本删掉——等用户想反悔时，回滚点已残缺且不可挽回。
  #    （同 lib/backup.ts 顶部那条 WAL 安全纪律；preupgrade.db 也是 VACUUM INTO 产的。）
  # 🔴 同 lib/backup.ts 的原子发布纪律：先写 .tmp- 临时名，成功后才 mv 就位——中途被杀
  #    不会留下一个残缺的 pre-restore.db 冒充回滚点。
  $SUDO rm -f "$PRE_RESTORE.tmp"
  DATA_DIR_ABS="$(absdir "$DATA_DIR")"
  BACKUP_DIR_ABS="$(absdir "$BACKUP_DIR")"   # 上面 install -d 刚建好，必存在
  node_in_data "$DATA_DIR_ABS" "$BACKUP_DIR_ABS" '
    const { DatabaseSync } = require("node:sqlite")
    const src = new DatabaseSync("/d/app.db")
    try {
      src.exec("PRAGMA busy_timeout = 5000")
      src.prepare("VACUUM INTO ?").run("/b/pre-restore.db.tmp")
    } finally {
      src.close()
    }
  ' || {
    echo "❌ 现场留存失败：产不出 $PRE_RESTORE" >&2
    echo "   已中止，$DB 未被改动（fail-closed：没有回滚点就不做破坏性还原）。" >&2
    echo "   如确认无需回滚点，手动移开当前库后重跑：mv $DB <你的存放路径>" >&2
    $SUDO rm -f "$PRE_RESTORE.tmp"
    exit 1
  }
  # 容器里覆盖了 entrypoint，那条 umask 077 不生效，产出可能是 0644——库含 OAuth 令牌快照与 CDK 码，收紧
  $SUDO chmod 600 "$PRE_RESTORE.tmp"
  $SUDO mv -- "$PRE_RESTORE.tmp" "$PRE_RESTORE"   # 就位（同目录 mv 原子）
else
  echo "→ 当前无 ${DB}，跳过现场留存"
fi

# 🔴 原子还原（P6-R2 R4④）：先 install 到临时名，成功后 mv 原子就位——仿 pre-restore.db.tmp 纪律。
#    原行为 `install $RESTORE_SRC $DB` 是原地覆盖：中途断电/磁盘满会留下截断的 app.db，需手动恢复。
#    同目录 mv 是原子操作（单 inode 改名），失败不会破坏目标、成功则瞬间完成。
echo "→ 还原快照为 ${DB}（0600 / uid1000）"
# shellcheck disable=SC2086
$SUDO install $OWN -m 600 "$RESTORE_SRC" "$DB.tmp"
$SUDO mv -- "$DB.tmp" "$DB"  # 就位（同目录 mv 原子）
[ "$RESTORE_SRC" = "$SNAPSHOT" ] || $SUDO rm -f "$RESTORE_SRC"   # 清掉临时副本

# -wal/-shm 是旧库的 WAL 副本，换整库快照时必须一并删除；
# 标记也要清——手动还原＝人为终结升级链，不清则下次真升级会因「标记指向的旧快照仍在」被误判、跳过备份。
echo "→ 清理 -wal/-shm 与升级标记"
$SUDO rm -f "$DB-wal" "$DB-shm" "$MARKER"

echo "→ 起 app"
docker compose start app

# 校验：先 liveness（进程起来了吗），再 readiness（库能读、schema 版本对得上吗）。
# readiness 才是「恢复成功」的判据——liveness 通过但 schema 不匹配说明还原错了版本的快照。
echo "→ 校验 $APP_URL/api/health 与 /api/ready（最多等 60s）"
# 🔴 单次请求必须有界（R4-P2④，codex R6 指出）：APP_URL 能建连但**永不返回响应**时（进程卡在
#    某个 await、反代挂起），无超时的 curl 会在一次迭代里无限阻塞——上面承诺的 60s 上限失效，
#    EXIT trap 也进不去、app 停在停止态。--connect-timeout 3 + --max-time 5 ⇒ 单轮最多 5s，
#    30 轮 × (≤5s + 2s sleep) 仍以有界时间收敛到下面的排查提示。
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS --connect-timeout 3 --max-time 5 -o /dev/null "$APP_URL/api/ready" 2>/dev/null; then
    echo "✅ 恢复完成：/api/ready 通过（库可读 + schema 版本匹配）"
    trap - EXIT  # 清 trap：readiness 通过 = 恢复成功，正常退出不用再 start
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "⚠️ 60s 内 /api/ready 未通过。排查：" >&2
echo "   docker compose logs -f app        # 看 [migrate]/[db] 版本行" >&2
echo "   curl -s $APP_URL/api/health       # liveness 通了说明进程活着，问题在库/schema" >&2
echo "   还原的若是更旧版本的快照，需要跑迁移或改用与当前镜像版本匹配的快照。" >&2
exit 1
