#!/bin/sh
# =============================================================================
# 从快照恢复数据库（P6-R2，docs/deploy.md §5.2 手工步骤的脚本化）
#
# **宿主侧运行**（在 docker-compose.yml 所在目录，即仓库根）。流程：
#   互斥锁 + 私有 stage 校验 → 停 app → 现场 app.db 存为 backups/pre-restore.db
#   → armed + 原子 mv stage 为 app.db（0600 / uid1000）→ 删旧 -wal/-shm/.upgrade-in-progress
#   → 起 app → 以 /api/ready 校验数据库与 schema 就绪 → 释放锁
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
#   READY_TIMEOUT 等 /api/ready 通过的秒数上限，默认 60（与 docs/deploy.md 承诺一致）
# =============================================================================
set -eu

DATA_DIR="${DATA_DIR:-data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
APP_URL="${APP_URL:-http://127.0.0.1:3000}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"
MARKER="$DATA_DIR/.upgrade-in-progress"
DB="$DATA_DIR/app.db"

# READY_TIMEOUT 会进入算术展开和 curl/sleep 参数，必须在任何 docker、停机或文件替换之前验证。
# 只接受 1..86400 的十进制正整数：既避免 /bin/sh 把 abc 当变量名/0，也避免超大值造成无限值守。
if ! printf '%s\n' "$READY_TIMEOUT" | grep -Eq '^[1-9][0-9]{0,4}$'; then
  echo "❌ READY_TIMEOUT 必须是 1..86400 的十进制正整数，得到：$READY_TIMEOUT" >&2
  exit 2
fi
if [ "$READY_TIMEOUT" -gt 86400 ]; then
  echo "❌ READY_TIMEOUT 必须是 1..86400 的十进制正整数，得到：$READY_TIMEOUT" >&2
  exit 2
fi

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

reject_nondefault_db_path() {
  _source="$1"
  echo "❌ restore.sh 不支持非默认 DB_PATH（${_source}检测到 DB_PATH=非默认值）。" >&2
  echo "本脚本拒绝降级为手工恢复：该布局尚未纳入同一套 header/quick_check、私有 stage、互斥锁与信号 trap 状态机。" >&2
  echo "不得通过 unset DB_PATH、清空 Compose 配置或猜测宿主挂载路径绕过；这些做法可能恢复错库或混入旧 WAL。" >&2
  echo "本次已在停服务和修改数据库前中止。请使用经独立复核、明确支持该挂载布局的恢复工具。" >&2
  echo "🔴 不可忽略本错误：强行执行会导致数据丢失。" >&2
  exit 2
}

if [ -n "${DB_PATH:-}" ] && [ "$DB_PATH" != "data/app.db" ]; then
  reject_nondefault_db_path "宿主侧"
fi

if [ -n "$CONTAINER_DB_PATH" ] && [ "$CONTAINER_DB_PATH" != "data/app.db" ]; then
  reject_nondefault_db_path "容器内"
fi

# 路径归一：docker -v 只认绝对路径（相对路径会被当成**命名卷**静默建一个空卷，
# 于是容器看到的是空目录、脚本却以为在读宿主的库）。恢复源也先解析到底再复制进私有 stage。
#
# 🔴 必须 fail-closed：`cd` 失败时 `$(...)` 只是取到空串，拼出来的会是 `/pre-restore.db` 这种
#    **看着像绝对路径的垃圾**——拿它当 `-v` 源就等于把宿主根目录 `/` 挂进容器。而这不是理论情形：
#    `data/backups` 按 §2 是 0700 且属主 uid1000，操作账号不是 1000 时 `cd` 必然 Permission denied。
#    故显式判空并中止。
# 🔴 R4-P1②：路径归一时解符号链接。恢复源可能是指向 pre-restore.db 的一层/多层链接；必须先
# 解析到真实目标，再在 stop 前复制到私有 stage。这样后面的现场留存即使覆盖原 pre-restore.db，
# 最终还原仍使用已校验的 stage，不会静默丢掉二次反悔回滚点。
#
# `cd -P` 追踪目录段，再对 basename 段**循环** readlink 直到不再是链接。必须循环而不是解一层：
# `snap.db -> mid.db -> pre-restore.db` 只解一层会留下仍会变化的中间链接。readlink 给相对目标时按其
# 所在目录解析；给绝对目标时直接接着走下一轮。
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
# 记住宿主调用者身份：内部 sudo 创建的 0700 锁目录必须还给调用者，否则 macOS uid501 / Linux
# 非 uid1000 操作员会在后续 shell 状态判断时失去目录遍历权。
CALLER_UID="$(id -u)"
CALLER_GID="$(id -g)"
if [ "$CALLER_UID" = "0" ]; then SUDO="${SUDO-}"; else SUDO="${SUDO-sudo}"; fi

# 属主移交（-o 1000 -g 1000）：容器以 uid1000 跑，宿主文件须归 1000，否则容器起来写不了库。
# 但**不能提权时 chown 必失败**——install 会中途报错、留下一个截断的目标文件。而这恰是
# macOS/Windows Docker Desktop 的常态（uid 自动映射、本就无需 chown，见 docs §2 的跳过注）。
# 故：能提权（root 或有 sudo）才带 -o/-g，否则只设权限位 600。
if [ -n "$SUDO" ] || [ "$CALLER_UID" = "0" ]; then
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

SNAPSHOT_ABS="$(abspath "$SNAPSHOT")"
DB_ABS="$(abspath "$DB")"

# 🔴 快照 == 目标库：还原「自己盖自己」没有意义，且下面 install 会因 same file 报错（exit 64）而
#    中止在半途（此时 app 已停、现场已存）。提前拒绝，给出清晰指引。
if [ "$SNAPSHOT_ABS" = "$DB_ABS" ]; then
  echo "❌ 快照就是当前库本身（${DB}），还原它没有意义。" >&2
  exit 2
fi

# 🔴 分叉守卫（docs §5.2）：标记在＝上次升级没走完。此时若直接 start，新镜像 entrypoint 见 schema
#    落后会拿刚还原的旧库重跑同一个失败迁移，回滚白做。旧代码/镜像只能先 build/pull 并 create
#    为停止态；数据库恢复完成前严禁 up/start。当前安全 restore 脚本还要先复制到 checkout 外保留。
if [ -f "$MARKER" ] && [ "$AFTER_ROLLBACK" -eq 0 ]; then
  cat >&2 <<EOF
🛑 检测到未完结的升级标记：$MARKER
   直接恢复会白做：新镜像启动时见 schema 落后，会拿还原后的旧库重跑同一个失败迁移。
   正确顺序：
     1) RECOVERY_SH="\$(mktemp)"; cp "$0" "\$RECOVERY_SH"; chmod 700 "\$RECOVERY_SH"
     2) docker compose stop app
     3) 把代码/镜像退回旧版本（git checkout <旧提交/tag>，或改 compose 切回旧镜像 tag）
     4) docker compose build app
     5) docker compose create --force-recreate app   # 只重建为停止态，绝不运行 entrypoint
     6) "\$RECOVERY_SH" --after-image-rollback <升级前快照路径> && rm -f "\$RECOVERY_SH"
   🔴 第 6 步前禁止 docker compose up/start；否则旧服务会在旧库恢复前启动并可能写入中间 schema。
EOF
  exit 3
fi

echo "→ 恢复源：$SNAPSHOT"
echo "→ 目标库：$DB"

# 🔴 restore 互斥 + 进程间状态：所有校验、替换与信号收尾都围绕 DATA_DIR 内的私有锁目录。
#
# 1) `mkdir` 是跨进程原子的：同一 DATA_DIR 同时只能有一个 restore，避免两个进程共享临时恢复源 /
#    pre-restore.tmp 后互相覆盖、rename，进而破坏“stage 是否仍存在”的状态判据。
# 2) 源快照先 install 为锁目录里的 0600 `snapshot.db`，**校验和最终 mv 使用同一份私有副本**：
#    原始路径（含 symlink 或普通文件）在校验后被替换，也不会变成“校验 A、安装 B”。
# 3) `replace-armed` 在最终 mv 前创建；它与 snapshot.db 是否仍存在共同编码进程可见阶段：
#      armed + stage 存在   → mv 未成功，当前 DB/WAL 必须保留；
#      armed + stage 不存在 → mv 已成功，旧 WAL/SHM 必须清掉后才能 start。
#    因为状态在文件系统 namespace 里，进程被 SIGKILL 后锁目录仍会阻止下一次 restore，并给出
#    人工恢复线索。这里没有 fsync 屏障，**不承诺宿主断电后的元数据持久顺序**；见 docs §5.2。
RESTORE_LOCK="$DATA_DIR/.restore-in-progress"
RESTORE_STAGE="$RESTORE_LOCK/snapshot.db"
RESTORE_ARMED_MARKER="$RESTORE_LOCK/replace-armed"
PRE_RESTORE_TMP="$BACKUP_DIR/pre-restore.db.tmp"
LOCK_HELD=0
STOP_ATTEMPTED=0

release_restore_lock() {
  [ "$LOCK_HELD" = "1" ] || return 0
  if [ ! -d "$RESTORE_LOCK" ]; then
    LOCK_HELD=0
    return 0
  fi
  if ! $SUDO rm -f "$RESTORE_STAGE" "$RESTORE_ARMED_MARKER"; then
    echo "❌ 无法清理 restore 锁目录里的临时状态：$RESTORE_LOCK" >&2
    return 1
  fi
  if ! $SUDO rmdir "$RESTORE_LOCK"; then
    echo "❌ 无法释放 restore 锁：$RESTORE_LOCK（请确认目录内无未知文件后人工处理）" >&2
    return 1
  fi
  LOCK_HELD=0
}

db_was_replaced() {
  [ -f "$RESTORE_ARMED_MARKER" ] && [ ! -e "$RESTORE_STAGE" ]
}

clean_replaced_sidecars() {
  # armed 不存在＝要么尚未进入替换，要么旧 sidecar 已清成功；两种情况都绝不能再删。
  [ -f "$RESTORE_ARMED_MARKER" ] || return 0
  # stage 仍在＝最终 mv 尚未成功，app.db/WAL 仍属于当前库，必须原样保留。
  [ ! -e "$RESTORE_STAGE" ] || return 0
  if ! $SUDO rm -f "$DB-wal" "$DB-shm"; then
    echo "❌ 数据库已替换，但无法删除旧 WAL/SHM；为防混库，拒绝重启 app。" >&2
    echo "   请保持 app 停止，修复权限后删除：$DB-wal $DB-shm。" >&2
    return 1
  fi
  # 先清 sidecar，成功后才撤销 armed。信号落在两者之间时 app 仍停着，重做 rm 安全；
  # armed 撤销后，任何后续 EXIT 都不会再删除新库运行中生成的 WAL。
  if ! $SUDO rm -f "$RESTORE_ARMED_MARKER"; then
    echo "❌ 旧 WAL/SHM 已删除，但无法推进 restore 状态；为防后续误清新 WAL，拒绝重启 app。" >&2
    return 1
  fi
}

cleanup_and_start() {
  _exit_rc=$?
  trap - EXIT INT TERM
  _restart_ok=1
  _keep_lock=0

  if db_was_replaced; then
    if ! clean_replaced_sidecars; then
      _restart_ok=0
      _keep_lock=1
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
    fi
  fi

  if [ "$STOP_ATTEMPTED" = "1" ] && [ "$_restart_ok" = "1" ]; then
    if ! docker compose start app; then
      echo "❌ restore 收尾无法重启 app；请执行 docker compose start app 并检查日志。" >&2
      _keep_lock=1
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
    fi
  elif [ "$_restart_ok" != "1" ]; then
    echo "🛑 app 保持停止：旧 WAL/SHM 尚未安全清除，不能与新数据库一起启动。" >&2
  fi

  # 现场 VACUUM 的临时文件永远不是正式回滚点；优雅退出时清掉。SIGKILL 来不及清时，Node
  # 片段的 umask 077 仍保证它不是 0644 敏感副本，且状态锁会阻断下一次 restore。
  if ! $SUDO rm -f "$PRE_RESTORE_TMP"; then
    echo "❌ 无法清理现场留存临时文件：$PRE_RESTORE_TMP" >&2
    [ "$_exit_rc" -ne 0 ] || _exit_rc=1
  fi

  if [ "$_keep_lock" = "0" ]; then
    if ! release_restore_lock; then
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
    fi
  else
    echo "🛑 已保留 restore 状态锁：$RESTORE_LOCK；完成上面的人工处置后再移除。" >&2
  fi

  exit "$_exit_rc"
}

if ! $SUDO mkdir "$RESTORE_LOCK"; then
  if [ -e "$RESTORE_LOCK" ]; then
    echo "🛑 已有另一个 restore 或上次异常中断的状态锁：$RESTORE_LOCK" >&2
    if [ -f "$RESTORE_ARMED_MARKER" ] && [ ! -e "$RESTORE_STAGE" ]; then
      echo "   状态显示：数据库可能已替换、旧 WAL/SHM 尚待确认。保持 app 停止，切勿直接 start。" >&2
    elif [ -f "$RESTORE_ARMED_MARKER" ]; then
      echo "   状态显示：替换已武装但 stage 仍在，数据库大概率尚未替换；仍需先确认现场。" >&2
    else
      echo "   状态显示：中断发生在替换前或清理后；请确认无 restore 进程再人工检查/移除锁。" >&2
    fi
    exit 4
  else
    echo "❌ 无法创建 restore 状态锁：$RESTORE_LOCK（目录权限、只读文件系统或磁盘故障）。" >&2
    exit 1
  fi
fi
LOCK_HELD=1
trap cleanup_and_start EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# 锁目录属于宿主调用者而不是容器 uid1000：shell 需要持续读取其中的状态文件名。stage 文件本身仍按
# OWN 交给容器 uid1000；宿主读取其内容时必须走 $SUDO（见下方文件头检查）。
if [ -n "$SUDO" ] && [ "$CALLER_UID" != "0" ]; then
  $SUDO chown "$CALLER_UID:$CALLER_GID" "$RESTORE_LOCK"
fi
$SUDO chmod 700 "$RESTORE_LOCK"

echo "→ 固化恢复源到私有 stage（0600）：$RESTORE_STAGE"
# shellcheck disable=SC2086  # $OWN 需按词拆分成 -o 1000 -g 1000（或空）
if ! $SUDO install $OWN -m 600 "$SNAPSHOT_ABS" "$RESTORE_STAGE"; then
  echo "❌ 无法复制恢复源到私有 stage；app 未停、当前数据库未改动。" >&2
  exit 1
fi

# 快照必须是 SQLite 库文件——错传日志/空文件不能进入 stop/替换阶段。检查的是私有 stage，
# 后续最终 mv 仍使用它，故不存在校验后源内容被替换的 TOCTOU。
if [ "$($SUDO head -c 15 "$RESTORE_STAGE" 2>/dev/null || true)" != "SQLite format 3" ]; then
  echo "❌ 不是 SQLite 库文件（缺 'SQLite format 3' 文件头）：$SNAPSHOT" >&2
  exit 1
fi

# 🔴 完整性校验（P6-R2 复审第 3 条）：`head -c 15` 只看文件头，一个**截断/损坏**的快照照样能过——
#    实测截到 2048 字节的库仍带 'SQLite format 3' 头，但 quick_check 抛 malformed。不校验就会
#    停服务、换库，直到 readiness 才发现，而那时现场已经被换掉了。故放在所有破坏性步骤之前。
#    只读打开（readOnly:true），绝不改动快照本身。
echo "→ 校验快照完整性（PRAGMA quick_check + header 1/1 单文件格式判据）"
# `immutable=1`（不是单纯 readOnly:true）：WAL 模式的快照主文件，SQLite 打开时即便只读也要在
# **同目录**建 -wal/-shm——挂 :ro 会直接报 "attempt to write a readonly database"，
# 把快照误判成坏的。immutable 让 SQLite 完全跳过 WAL/锁机制，只读文件本身；实测仍能检出
# 截断（2048 字节）与页损坏（均抛 malformed），且不在宿主目录留任何副产物。
#
# 🔴 R7-P1①（codex R6 指出）：拒绝「从活动 WAL 库裸 cp 来的主文件」。
#
#    quick_check 拦不住这种快照：WAL 库的已提交数据可能**只存在于 -wal sidecar 里**，只拷主文件
#    就把那部分丢了，而剩下的页本身结构完好 → quick_check 返回 ok、恢复"成功"、readiness 也过，
#    数据却静默少了一截。本轮实测复现：源库 150 行（100 行已 checkpoint + 50 行只在 WAL 里），
#    裸 cp 主文件 → quick_check=ok 但只有 100 行；VACUUM INTO 产物 → 150 行。
#
#    判据用**文件头 offset 18-19**（两个字节：file format write/read version），不是 PRAGMA：
#      · 1/1 (0101) = 已知安全的 journal 单文件格式（VACUUM INTO 的产物）→ 接受
#      · 2/2 (0202) = WAL 模式 → 主文件**可能**不自足，配套 -wal 才是完整状态 → 拒绝
#      · 其他未知/混合值没有经过安全证明 → 一律 fail-closed 拒绝；不能把“不是 2”误当成安全
#    ⚠️ 实测澄清（codex 建议用 `PRAGMA journal_mode` 判，本轮验证后改用文件头）：immutable=1 打开时
#       `PRAGMA journal_mode` 对两种快照**都返回 delete**（immutable 让 SQLite 完全绕开 WAL 机制、
#       报的是"当前连接的有效模式"而非文件真实形态）——照 PRAGMA 判会全部放行，等于没修。文件头
#       字节是磁盘上的事实，不受打开方式影响，故以它为准。
#
#    ⚠️ 已知误拒（有意接受，fail-closed 取向）：**干净关闭**的 WAL 库（close 时自动 checkpoint 并
#       删掉 sidecar）主文件头仍是 0202，但内容是完整的——这种快照会被本守卫一并拒掉。实测确认过
#       这个误拒类。取舍理由：从磁盘上的单个文件**无法区分**「干净关闭的 WAL 库」与「活动库裸 cp
#       的残缺主文件」（两者头字节、quick_check 全都一样）。误拒的代价是运维换用 VACUUM INTO 重做
#       一份快照（脚本下面给了确切命令）；放行的代价是静默丢数据、且要到很久以后才发现。宁可误拒。
#       docs §5.3 的 sync-backups.sh 异机备份链路取的都是 backupDb() 的 VACUUM 产物（0101），
#       正常运维路径不受影响。
#    ⚠️ 非默认 DB_PATH 也不再给出弱化手工配方；所有恢复都必须复用同一套校验和状态机。
node_with_snapshot "$RESTORE_STAGE" '
  const fs = require("fs")
  const { DatabaseSync } = require("node:sqlite")
  // 先看文件头：offset 18/19 = write/read format version。仅 1/1 是本恢复器已知安全的单文件形态。
  const fd = fs.openSync("/snap.db", "r")
  const hdr = Buffer.alloc(20)
  try {
    fs.readSync(fd, hdr, 0, 20, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (hdr[18] !== 1 || hdr[19] !== 1) {
    console.error(`UNSAFE_SNAPSHOT_HEADER:${hdr[18]}/${hdr[19]}`)
    process.exit(hdr[18] === 2 && hdr[19] === 2 ? 2 : 3)
  }
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
  _vrc=$?
  if [ "$_vrc" = "2" ]; then
    cat >&2 <<EOF
❌ 快照是 WAL 模式的主文件，拒绝使用：${SNAPSHOT}
   WAL 库的已提交数据可能只在配套的 -wal 文件里，单独还原这个主文件会**静默丢数据**
   （结构完好、quick_check 通过、readiness 也过，但内容少一截）。
   请改用 VACUUM INTO 产出的一致性快照——data/backups/backup-*.db 就是（scripts/backup.ts
   与 worker 每日备份的产物）。若手里只有这个 WAL 库，先在**它自己的**机器上转成一致性快照：
     docker compose run --rm --no-deps -T --entrypoint node app -e \\
       'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("<该库路径>");d.exec("VACUUM INTO \"<输出路径>\"");d.close()'
   注：干净关闭的 WAL 库其实内容完整，但磁盘上与「活动库裸 cp」无法区分，故一并拒绝（宁可误拒）。
EOF
    echo "   已中止，${DB} 未被改动，app 也未停。" >&2
    exit 1
  fi
  if [ "$_vrc" = "3" ]; then
    echo "❌ 快照 header bytes 18/19 不是已知安全的 1/1，拒绝使用：${SNAPSHOT}" >&2
    echo "   本恢复器只接受 VACUUM INTO 产出的 1/1 journal 单文件格式；未知或混合值一律 fail-closed。" >&2
    echo "   已中止，${DB} 未被改动，app 也未停。" >&2
    exit 1
  fi
  echo "❌ 快照未通过完整性校验（截断/损坏）：$SNAPSHOT" >&2
  echo "   已中止，$DB 未被改动，app 也未停。换一份快照重试。" >&2
  exit 1
}

# trap 必须在 stop **之前**安装：stop 已完成、下一行尚未执行的同类信号窗口也会让 app 永久停机。
# 提前安装后，即便信号落在 stop 命令内部/刚返回时，收尾也会幂等 start；若 app 尚未停，start 亦无害。
STOP_ATTEMPTED=1
echo "→ 停 app（释放对 app.db 的写锁）"
docker compose stop app

# 现场先存一份：单文件覆盖式，仿 preupgrade.db 的钉住模式——文件名不匹配 ^backup-.*\.db$，
# 故不进 BACKUP_KEEP 轮转集，也不会被 latestBackupDay 误当成「今天的日常备份」。
PRE_RESTORE="$BACKUP_DIR/pre-restore.db"
if [ -f "$DB" ]; then
  echo "→ 存下当前现场：${PRE_RESTORE}（覆盖上一次的同名文件）"
  # shellcheck disable=SC2086  # $OWN 需按词拆分成 -o 1000 -g 1000（或空）
  $SUDO install -d $OWN -m 700 "$BACKUP_DIR"

  # 🔴 自毁防护（P6-R2 复审必修 1）：用户跑过一次 restore 后想拿 pre-restore.db 回到最初状态，
  #    是最自然的二次反悔路径。但本步会用**当前 app.db** 重建同名文件；若仍从原路径读取，恢复源
  #    会在 install 前被覆盖。现在所有源都已在 stop 前固化到 $RESTORE_STAGE，并对那一份做过校验，
  #    所以即使原始 SNAPSHOT 就是 pre-restore.db，本步覆盖原文件也不影响最终恢复内容。

  # 🔴 必须 VACUUM INTO，绝不能 cp/install：库跑 WAL 模式，`docker compose stop` 发 SIGTERM 后进程
  #    不做 checkpoint 就退出，最后一段已提交数据只躺在 app.db-wal 里。裸拷主文件会丢这段，而下面
  #    紧接着 `rm -f "$DB-wal"` 会把唯一副本删掉——等用户想反悔时，回滚点已残缺且不可挽回。
  #    （同 lib/backup.ts 顶部那条 WAL 安全纪律；preupgrade.db 也是 VACUUM INTO 产的。）
  # 🔴 同 lib/backup.ts 的原子发布纪律：先写 .tmp- 临时名，成功后才 mv 就位——中途被杀
  #    不会留下一个残缺的 pre-restore.db 冒充回滚点。
  $SUDO rm -f "$PRE_RESTORE_TMP"
  DATA_DIR_ABS="$(absdir "$DATA_DIR")"
  BACKUP_DIR_ABS="$(absdir "$BACKUP_DIR")"   # 上面 install -d 刚建好，必存在
  node_in_data "$DATA_DIR_ABS" "$BACKUP_DIR_ABS" '
    const { DatabaseSync } = require("node:sqlite")
    process.umask(0o077) // entrypoint 被覆盖时也保证 VACUUM 产物从创建起就是 0600
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
    $SUDO rm -f "$PRE_RESTORE_TMP"
    exit 1
  }
  # Node 片段已先设 umask 077；宿主再 chmod 一次作纵深防御。
  $SUDO chmod 600 "$PRE_RESTORE_TMP"
  $SUDO mv -- "$PRE_RESTORE_TMP" "$PRE_RESTORE"   # 就位（同目录 mv 原子）
else
  echo "→ 当前无 ${DB}，跳过现场留存"
fi

# 🔴 原子还原（P6-R2 R4④ + R7-P1②）：私有 stage 已完整写好、收紧权限并通过校验；先创建 armed
#    标记，再把同一文件原子 mv 为 app.db。EXIT/INT/TERM 与进程级 SIGKILL 后，可用当前文件系统
#    可见的 armed + stage 状态判断 mv 结果；不把它冒充为未经 fsync 的宿主断电一致性保证。
echo "→ 原子还原已校验 stage 为 ${DB}（0600 / uid1000）"
$SUDO install -m 600 /dev/null "$RESTORE_ARMED_MARKER"
$SUDO mv -- "$RESTORE_STAGE" "$DB"  # DATA_DIR 内同一文件系统，rename 原子

# -wal/-shm 是旧库的 WAL 副本，换整库快照时必须一并删除；
# 标记也要清——手动还原＝人为终结升级链，不清则下次真升级会因「标记指向的旧快照仍在」被误判、跳过备份。
echo "→ 清理 -wal/-shm 与升级标记"
clean_replaced_sidecars
$SUDO rm -f "$MARKER"

echo "→ 起 app"
docker compose start app

# 校验：readiness 才是「恢复成功」的判据——它同时证明进程已能响应，并核对
# 常驻连接、DB_PATH 文件身份、fresh 磁盘连接与两侧 schema。单独查 liveness 只能说明
# 进程活着，不能证明常驻连接仍指向当前路径上的数据库，故不作为独立恢复门禁。
echo "→ 校验 $APP_URL/api/ready（最多等 ${READY_TIMEOUT}s）"
# 🔴 单次请求必须有界（R4-P2④，codex R6 指出）：APP_URL 能建连但**永不返回响应**时（进程卡在
#    某个 await、反代挂起），无超时的 curl 会在一次迭代里无限阻塞——承诺的 60s 上限失效，
#    EXIT trap 也进不去、app 停在停止态。--connect-timeout 3 + --max-time 5 ⇒ 单轮最多 5s。
#
# 🔴 R7-P2⑥（codex R6 指出）：上限必须是**绝对 deadline**，不能靠「迭代次数 × 预估单轮耗时」。
#    修复前是 `while [ i -lt 30 ]` + 单轮最多 5s + sleep 2：正常情况下（连接被拒、curl 立即返回）
#    单轮≈2s、30 轮≈60s 与承诺相符；但**恰好在 readiness 卡住时**（接受连接却不响应，即最需要
#    这个上限的场景）单轮变成 5+2=7s → 实际约 210s，是承诺的 3.5 倍。运维照文档等 60s 就会以为
#    脚本挂了而手动打断，而打断点可能落在 trap 之外的任意位置。
#    改法：开跑记 DEADLINE=now+60；每轮把 curl 与 sleep 都钳到剩余秒数，不能让最后一轮越界。
#    上限可用 READY_TIMEOUT 覆盖（回归测试要跑「等满上限」这条路径，60s 会让整套测试慢一倍；
#    运维侧偶尔也需要放宽——冷启动慢的大库首次加载可能超 60s）。默认值仍是文档承诺的 60。
_deadline=$(( $(date +%s) + READY_TIMEOUT ))
while :; do
  _now=$(date +%s)
  _remaining=$((_deadline - _now))
  [ "$_remaining" -gt 0 ] || break

  _curl_timeout=5
  if [ "$_remaining" -lt "$_curl_timeout" ]; then
    _curl_timeout="$_remaining"
  fi
  if curl -fsS --connect-timeout 3 --max-time "$_curl_timeout" -o /dev/null "$APP_URL/api/ready" 2>/dev/null; then
    echo "✅ 恢复完成：/api/ready 通过（库可读 + schema 版本匹配）"
    release_restore_lock
    trap - EXIT INT TERM  # 恢复成功：清掉收尾与信号 trap，正常退出不用再 start
    exit 0
  fi

  _now=$(date +%s)
  _remaining=$((_deadline - _now))
  [ "$_remaining" -gt 0 ] || break
  _sleep_for=2
  if [ "$_remaining" -lt "$_sleep_for" ]; then
    _sleep_for="$_remaining"
  fi
  sleep "$_sleep_for"
done

echo "⚠️ ${READY_TIMEOUT}s 内 /api/ready 未通过。排查：" >&2
echo "   docker compose logs -f app        # 看 [migrate]/[db] 版本行" >&2
echo "   curl -s $APP_URL/api/health       # liveness 通了说明进程活着，问题在库/schema" >&2
echo "   还原的若是更旧版本的快照，需要跑迁移或改用与当前镜像版本匹配的快照。" >&2
exit 1
