#!/bin/sh
# =============================================================================
# 从快照恢复数据库（P6-R2，docs/deploy.md §5.2 手工步骤的脚本化）
#
# **宿主侧运行**（在 docker-compose.yml 所在目录，即仓库根）。流程：
#   Compose + 容器/mount/网络身份核对 → host-only 控制锁 + app 不可见预校验副本 → 停 app
#   → 同文件系统 stage 二次校验 → 现场 app.db 存为 backups/pre-restore.db → armed + 原子 mv
#   → 停止态断开捕获容器的全部流量网络 → 精确启动该容器 → 容器内校验 /api/ready
#   → 先持久化 ready-accepted → 按 network ID + aliases 恢复网络 → network-published
#   → 最后身份复核 → 原子保全 accepted 并释放 host-only control
#
# 用法：
#   ./scripts/restore.sh data/backups/backup-2026-07-26T01-00-00-a1b2c3.db
#   ./scripts/restore.sh --after-image-rollback data/backups/preupgrade.db
#
# 环境变量：
#   SUDO=        仅当宿主 UID 与容器 uid1000 明确隔离（常见于 macOS Docker Desktop）时可置空；
#                Linux uid1000 调用者必须保留默认 sudo（或用 root），否则无法隔离锁/stage 与 app；
#                Linux 跨 UID 残锁 owner 的 boot_id + /proc starttime 核验也通过这条提权路径完成
#   DATA_DIR     宿主数据目录，默认 data。🔴 **必须与 docker-compose.yml 里绑到 /app/data 的宿主
#                路径一致**（默认那条是 `./data:/app/data`）：脚本按它定位要还原的库文件，容器按
#                compose 那条绑定定位它实际读的库——两者必须指同一个目录，否则还原了个 app 根本
#                不读的文件。脚本会在锁定/停机/写库前同时核对 Compose 与现有 app 容器实际挂载，
#                并固定到物理绝对路径；无法唯一确认就拒绝。
#   BACKUP_DIR   备份目录，默认 $DATA_DIR/backups
#   APP_URL      超时后的宿主侧排障提示地址，默认 http://127.0.0.1:3000；恢复门禁固定在捕获容器内探测
#   READY_TIMEOUT 等 /api/ready 通过的秒数上限，默认 60（与 docs/deploy.md 承诺一致）
# =============================================================================
set -eu

DATA_DIR="${DATA_DIR:-data}"
if [ -z "${BACKUP_DIR+x}" ] || [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR_IS_DEFAULT=1
  BACKUP_DIR="$DATA_DIR/backups"
else
  BACKUP_DIR_IS_DEFAULT=0
fi
APP_URL="${APP_URL:-http://127.0.0.1:3000}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"

# READY_TIMEOUT 会进入算术展开和 probe/sleep 参数，必须在任何 docker、停机或文件替换之前验证。
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
#    ⚠️ 这次 YAML 查询若失败，CONTAINER_DB_PATH 会暂取空；但下面独立的 JSON 挂载门禁要求同一份
#       Compose 配置必须成功解析，否则在创建锁、停机或写库前直接 fail-closed，不会继续恢复。
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
# 解析到真实目标，再在 stop 前复制到 app 未挂载的 host-only 预校验副本。这样后面的现场留存即使
# 覆盖原 pre-restore.db，最终还原仍使用已固化副本，不会静默丢掉二次反悔回滚点。
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
  _d=$(cd -P -- "$1" 2>/dev/null && pwd -P) || _d=""
  if [ -z "$_d" ]; then
    echo "❌ 目录不存在或无权进入：$1" >&2
    echo "   $DATA_DIR 按 docs §2 是 0700/属主 uid1000；操作账号不是 1000 时请用 sudo 跑本脚本。" >&2
    exit 1
  fi
  printf '%s\n' "$_d"
}

# 目录物理身份：规范路径只能挡 symlink 换靶，挡不住同一路径被 rename 后换成另一个目录。
# macOS/BSD 与 GNU stat 参数不同，按顺序探测；两者都失败即 fail-closed。
path_identity() {
  _identity=$(stat -f '%d:%i' -- "$1" 2>/dev/null || true)
  case "$_identity" in
    *[!0-9:]*|'') _identity="" ;;
  esac
  if [ -z "$_identity" ]; then
    _identity=$(stat -Lc '%d:%i' -- "$1" 2>/dev/null || true)
    case "$_identity" in
      *[!0-9:]*|'') _identity="" ;;
    esac
  fi
  if [ -z "$_identity" ]; then
    echo "❌ 无法读取目录 dev/inode 身份：$1" >&2
    return 1
  fi
  printf '%s\n' "$_identity"
}

path_contains() {
  _path_root=${1%/}
  _path_candidate=$2
  [ "$_path_root" = "/" ] && return 0
  [ "$_path_candidate" = "$_path_root" ] ||
    [ "${_path_candidate#"$_path_root"/}" != "$_path_candidate" ]
}

validate_control_not_exposed_by_binds() {
  _bind_label=$1
  _bind_sources=$2
  _control_candidate="${DATA_DIR}.restore-control"
  _control_handoff_candidate="${DATA_DIR}.restore-control-accepted"

  while IFS= read -r _bind_source; do
    [ -n "$_bind_source" ] || continue
    if [ ! -e "$_bind_source" ]; then
      echo "❌ ${_bind_label} bind source 不存在，无法证明 host-only 控制面不可见：$_bind_source" >&2
      return 1
    fi
    _bind_abs=$(abspath "$_bind_source") || return 1
    if [ -d "$_bind_abs" ] && {
      path_contains "$_bind_abs" "$_control_candidate" ||
        path_contains "$_bind_abs" "$_control_handoff_candidate"
    }; then
      echo "❌ ${_bind_label} bind source 是 host-only restore 控制路径的祖先，拒绝恢复。" >&2
      echo "   Bind source: $_bind_abs" >&2
      echo "   Control:     $_control_candidate" >&2
      return 1
    fi
    if [ "$_bind_abs" = "$_control_candidate" ] || [ "$_bind_abs" = "$_control_handoff_candidate" ]; then
      echo "❌ ${_bind_label} 直接绑定了 host-only restore 控制路径，拒绝恢复：$_bind_abs" >&2
      return 1
    fi
  done <<EOF
$_bind_sources
EOF
}

RESTORE_CONTAINER_ID=""
RESTORE_DATA_IDENTITY=""
RESTORE_COMPOSE_DATA_ABS=""
RESTORE_CONTAINER_DATA_ABS=""
RESTORE_CONTAINER_IMAGE=""
RESTORE_COMPOSE_PROJECT=""
RESTORE_COMPOSE_SERVICE=""
RESTORE_COMPOSE_CONFIG_HASH=""
RESTORE_CONTAINER_WAS_RUNNING=""
IDENTITY_DRIFTED=0

# restore 的宿主目标必须同时匹配 Compose 配置与现有唯一 app 容器实际绑到 /app/data 的 bind
# source。所有查询只读；任何缺失、歧义、named volume、解析失败或路径不一致都在创建 restore 锁、
# 停服务和写数据库之前 fail closed。
validate_compose_data_bind() {
  _compose_json=$(docker compose config --format json app 2>/dev/null) || {
    echo "❌ 无法解析 docker compose 配置，不能确认 /app/data 的宿主 bind source；恢复已中止。" >&2
    return 1
  }
  _compose_hash_rows=$(docker compose config --hash app 2>/dev/null) || {
    echo "❌ 无法计算当前 app Compose config hash；不能证明停止态容器配置未陈旧。" >&2
    return 1
  }
  _compose_config_hash=$(printf '%s\n' "$_compose_hash_rows" | awk 'NF == 2 && $1 == "app" { print $2 }')
  _compose_hash_count=$(printf '%s\n' "$_compose_config_hash" | awk 'NF { count++ } END { print count + 0 }')
  _compose_config_hash=$(printf '%s\n' "$_compose_config_hash" | awk 'NF { print; exit }')
  if [ "$_compose_hash_count" -ne 1 ] || [ "${#_compose_config_hash}" -ne 64 ]; then
    echo "❌ 当前 app Compose config hash 缺失或歧义；恢复已中止。" >&2
    return 1
  fi
  case "$_compose_config_hash" in *[!0-9a-f]*)
    echo "❌ 当前 app Compose config hash 格式异常；恢复已中止。" >&2
    return 1
  esac
  if [ -n "$RESTORE_COMPOSE_CONFIG_HASH" ] && [ "$_compose_config_hash" != "$RESTORE_COMPOSE_CONFIG_HASH" ]; then
    echo "❌ 恢复期间 Compose app 配置 hash 已变化，拒绝继续。" >&2
    return 1
  fi

  # Docker Compose 的 JSON 是缩进后的规范化模型。这里精确进入 services.app 的 direct child，
  # 只解析它的 networks 与 volumes：environment/labels/其他 service/顶层 networks 里即使出现
  # interface_name、mac_address 等同名 key，也不能误判成 app endpoint 配置。
  #
  # 路径只接受未转义的普通 Unix 字符串；若 JSON 含转义或结构不是预期对象/数组，宁可拒绝，也不
  # 猜测一个可能指向错误数据库或把 host-only 控制 sibling 暴露给 app 的 bind source。
  _compose_records=$(printf '%s\n' "$_compose_json" | awk '
    function indent_of(line) {
      match(line, /^[[:space:]]*/)
      return RLENGTH
    }
    BEGIN {
      in_services = 0
      in_app = 0
      in_networks = 0
      in_endpoint = 0
      in_volumes = 0
      in_mount = 0
      saw_services = 0
      saw_app = 0
      saw_volumes = 0
      bad = 0
    }

    !in_services && /^[[:space:]]*"services"[[:space:]]*:[[:space:]]*\{[[:space:]]*$/ {
      in_services = 1
      services_indent = indent_of($0)
      saw_services = 1
      next
    }
    in_services && !in_app && indent_of($0) == services_indent + 2 &&
      /^[[:space:]]*"app"[[:space:]]*:[[:space:]]*\{[[:space:]]*$/ {
      in_app = 1
      app_indent = indent_of($0)
      saw_app = 1
      next
    }

    in_app && !in_networks && !in_volumes && indent_of($0) == app_indent + 2 &&
      /^[[:space:]]*"mac_address"[[:space:]]*:/ {
      print "BAD\tservices.app.mac_address"
      next
    }
    in_app && !in_networks && indent_of($0) == app_indent + 2 &&
      /^[[:space:]]*"networks"[[:space:]]*:[[:space:]]*\{[[:space:]]*$/ {
      in_networks = 1
      networks_indent = indent_of($0)
      next
    }
    in_networks {
      line_indent = indent_of($0)
      if (!in_endpoint && line_indent == networks_indent && $0 ~ /^[[:space:]]*\}[,]?[[:space:]]*$/) {
        in_networks = 0
        next
      }
      if (!in_endpoint && line_indent == networks_indent + 2 &&
          $0 ~ /^[[:space:]]*"[^"\\]+"[[:space:]]*:[[:space:]]*\{[[:space:]]*$/) {
        in_endpoint = 1
        endpoint_indent = line_indent
        next
      }
      if (!in_endpoint && line_indent == networks_indent + 2 &&
          $0 ~ /^[[:space:]]*"[^"\\]+"[[:space:]]*:[[:space:]]*null[,]?[[:space:]]*$/) {
        next
      }
      if (!in_endpoint && line_indent == networks_indent + 2 &&
          $0 ~ /^[[:space:]]*"[^"\\]+"[[:space:]]*:[[:space:]]*\{\}[,]?[[:space:]]*$/) {
        next
      }
      if (!in_endpoint && line_indent == networks_indent + 2) {
        bad = 1
        next
      }
      if (in_endpoint && line_indent == endpoint_indent && $0 ~ /^[[:space:]]*\}[,]?[[:space:]]*$/) {
        in_endpoint = 0
        next
      }
      if (in_endpoint && line_indent == endpoint_indent + 2) {
        key = $0
        sub(/^[[:space:]]*"/, "", key)
        sub(/"[[:space:]]*:.*$/, "", key)
        if (key == "ipv4_address" || key == "ipv6_address" || key == "link_local_ips" ||
            key == "mac_address" || key == "interface_name" || key == "driver_opts") {
          print "BAD\tservices.app.networks.*." key
        } else if (key == "priority" || key == "gw_priority") {
          value = $0
          sub(/^[^:]*:[[:space:]]*/, "", value)
          sub(/[,[:space:]]*$/, "", value)
          if (value !~ /^-?0([.]0+)?$/) print "BAD\tservices.app.networks.*." key
        }
      }
      next
    }

    in_app && !in_volumes && indent_of($0) == app_indent + 2 &&
      /^[[:space:]]*"volumes"[[:space:]]*:[[:space:]]*\[[[:space:]]*$/ {
      in_volumes = 1
      volumes_indent = indent_of($0)
      saw_volumes = 1
      next
    }
    in_volumes {
      line_indent = indent_of($0)
      if (!in_mount && line_indent == volumes_indent && $0 ~ /^[[:space:]]*\][,]?[[:space:]]*$/) {
        in_volumes = 0
        next
      }
      if (!in_mount && $0 ~ /^[[:space:]]*\{[[:space:]]*$/) {
        in_mount = 1
        mount_indent = line_indent
        type = source = target = ""
        next
      }
      if (in_mount && $0 ~ /^[[:space:]]*"type"[[:space:]]*:/) {
        value = $0
        sub(/^[[:space:]]*"type"[[:space:]]*:[[:space:]]*"/, "", value)
        if (value ~ /\\/ || value !~ /"[,]?[[:space:]]*$/) bad = 1
        sub(/"[,]?[[:space:]]*$/, "", value)
        type = value
        next
      }
      if (in_mount && $0 ~ /^[[:space:]]*"source"[[:space:]]*:/) {
        value = $0
        sub(/^[[:space:]]*"source"[[:space:]]*:[[:space:]]*"/, "", value)
        if (value ~ /\\/ || value !~ /"[,]?[[:space:]]*$/) bad = 1
        sub(/"[,]?[[:space:]]*$/, "", value)
        source = value
        next
      }
      if (in_mount && $0 ~ /^[[:space:]]*"target"[[:space:]]*:/) {
        value = $0
        sub(/^[[:space:]]*"target"[[:space:]]*:[[:space:]]*"/, "", value)
        if (value ~ /\\/ || value !~ /"[,]?[[:space:]]*$/) bad = 1
        sub(/"[,]?[[:space:]]*$/, "", value)
        target = value
        next
      }
      if (in_mount && line_indent == mount_indent && $0 ~ /^[[:space:]]*\}[,]?[[:space:]]*$/) {
        if (type == "" || source == "" || target == "") bad = 1
        print "MOUNT\t" type "\t" source "\t" target
        in_mount = 0
        next
      }
      next
    }

    in_app && !in_networks && !in_volumes && indent_of($0) == app_indent &&
      /^[[:space:]]*\}[,]?[[:space:]]*$/ {
      in_app = 0
      next
    }
    in_services && !in_app && indent_of($0) == services_indent &&
      /^[[:space:]]*\}[,]?[[:space:]]*$/ {
      in_services = 0
      next
    }
    END {
      if (bad || in_endpoint || in_networks || in_mount || in_volumes || in_app ||
          in_services || !saw_services || !saw_app || !saw_volumes) exit 2
    }
  ') || {
    echo "❌ 无法可靠解析 Compose app 的网络/挂载配置；恢复已中止。" >&2
    return 1
  }

  _unsupported_compose_networks=$(printf '%s\n' "$_compose_records" | awk -F '\t' '$1 == "BAD" { print $2 }')
  if [ -n "$_unsupported_compose_networks" ]; then
    echo "❌ Compose app 网络包含 restore 无法无损重放的静态/自定义端点配置；恢复已中止：" >&2
    printf '   %s\n' "$_unsupported_compose_networks" >&2
    echo "   当前恢复器仅支持动态地址与 aliases；不会猜测或重放静态网络参数。" >&2
    return 1
  fi

  _data_mounts=$(printf '%s\n' "$_compose_records" | awk -F '\t' \
    '$1 == "MOUNT" && $4 == "/app/data" { print $2 "\t" $3 }')

  _mount_count=$(printf '%s\n' "$_data_mounts" | awk 'NF { count++ } END { print count + 0 }')
  if [ "$_mount_count" -ne 1 ]; then
    echo "❌ Compose 必须为 app 的 /app/data 配置唯一一个宿主 bind source；检测到 ${_mount_count} 个。" >&2
    return 1
  fi

  _mount_type=$(printf '%s\n' "$_data_mounts" | awk -F '\t' 'NR == 1 { print $1 }')
  _mount_source=$(printf '%s\n' "$_data_mounts" | awk 'NR == 1 { tab = index($0, "\t"); if (tab > 0) print substr($0, tab + 1) }')
  if [ "$_mount_type" != "bind" ] || [ -z "$_mount_source" ]; then
    echo "❌ Compose 的 /app/data 必须是可解析的宿主 bind source，不能使用 named volume。" >&2
    return 1
  fi

  _compose_data_abs=$(absdir "$_mount_source") || return 1
  _requested_data_abs=$(absdir "$DATA_DIR") || return 1
  if [ "$_compose_data_abs" != "$_requested_data_abs" ]; then
    echo "❌ DATA_DIR 与 Compose 的 /app/data bind source 不一致，拒绝恢复。" >&2
    echo "   DATA_DIR: $_requested_data_abs" >&2
    echo "   Compose:  $_compose_data_abs" >&2
    return 1
  fi

  _compose_bind_sources=$(printf '%s\n' "$_compose_records" | awk -F '\t' \
    '$1 == "MOUNT" && $2 == "bind" { print $3 }')
  validate_control_not_exposed_by_binds "Compose app" "$_compose_bind_sources" || return 1

  # `docker compose start` 会复用现有容器，不会按刚修改过的 Compose 配置重建。故还要核对将被
  # start 的唯一 app 容器：它当前实际挂到 /app/data 的 bind source 也必须与配置和 DATA_DIR 一致。
  _container_ids=$(docker compose ps --all --no-trunc -q app 2>/dev/null) || {
    echo "❌ 无法查询现有 app 容器，不能确认其 /app/data 实际挂载；恢复已中止。" >&2
    return 1
  }
  _container_count=$(printf '%s\n' "$_container_ids" | awk 'NF { count++ } END { print count + 0 }')
  if [ "$_container_count" -eq 0 ] && [ -z "$RESTORE_CONTAINER_ID" ]; then
    echo "→ 当前尚无 app 容器，按已核验 Compose 配置 create 为停止态"
    if ! docker compose create app; then
      echo "❌ 无法 create app 停止态容器；恢复已中止。" >&2
      return 1
    fi
    _container_ids=$(docker compose ps --all --no-trunc -q app 2>/dev/null) || return 1
    _container_count=$(printf '%s\n' "$_container_ids" | awk 'NF { count++ } END { print count + 0 }')
  fi
  if [ "$_container_count" -ne 1 ]; then
    echo "❌ 恢复前必须存在唯一一个 app 容器；检测到 ${_container_count} 个。" >&2
    echo "   请先按当前 Compose 配置 create/recreate 为停止态，再重新运行 restore。" >&2
    return 1
  fi
  _container_id=$(printf '%s\n' "$_container_ids" | awk 'NF { print; exit }')
  if ! printf '%s\n' "$_container_id" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "❌ Compose app 容器 ID 不是完整 64 位十六进制值，拒绝继续恢复。" >&2
    return 1
  fi
  _inspected_container_id=$(docker inspect --format '{{.Id}}' "$_container_id" 2>/dev/null) || {
    echo "❌ 无法反向核对 Compose 捕获的完整 app 容器 ID。" >&2
    return 1
  }
  if [ "$_inspected_container_id" != "$_container_id" ]; then
    echo "❌ docker inspect 返回的容器 ID 与 Compose 捕获值不一致，拒绝继续恢复。" >&2
    echo "   Compose: $_container_id" >&2
    echo "   Inspect: $_inspected_container_id" >&2
    return 1
  fi
  if [ -n "$RESTORE_CONTAINER_ID" ] && [ "$_container_id" != "$RESTORE_CONTAINER_ID" ]; then
    echo "❌ app 容器身份已漂移，拒绝继续恢复。" >&2
    echo "   Captured: $RESTORE_CONTAINER_ID" >&2
    echo "   Current:  $_container_id" >&2
    return 1
  fi
  _container_mounts=$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{printf "%s\t%s\n" .Type .Source}}{{end}}{{end}}' \
    "$_container_id" 2>/dev/null) || {
    echo "❌ 无法读取 app 容器的 /app/data 实际挂载；恢复已中止。" >&2
    return 1
  }
  _container_mount_count=$(printf '%s\n' "$_container_mounts" | awk 'NF { count++ } END { print count + 0 }')
  if [ "$_container_mount_count" -ne 1 ]; then
    echo "❌ app 容器必须为 /app/data 配置唯一一个实际挂载；检测到 ${_container_mount_count} 个。" >&2
    return 1
  fi
  _container_mount_type=$(printf '%s\n' "$_container_mounts" | awk -F '\t' 'NR == 1 { print $1 }')
  _container_mount_source=$(printf '%s\n' "$_container_mounts" | awk 'NR == 1 { tab = index($0, "\t"); if (tab > 0) print substr($0, tab + 1) }')
  if [ "$_container_mount_type" != "bind" ] || [ -z "$_container_mount_source" ]; then
    echo "❌ app 容器的 /app/data 实际挂载必须是可解析的宿主 bind source。" >&2
    return 1
  fi
  _container_data_abs=$(absdir "$_container_mount_source") || return 1
  if [ "$_container_data_abs" != "$_compose_data_abs" ]; then
    echo "❌ 现有 app 容器的 /app/data 挂载与当前 Compose 配置不一致，拒绝恢复。" >&2
    echo "   Container: $_container_data_abs" >&2
    echo "   Compose:   $_compose_data_abs" >&2
    echo "   请先 create/recreate app 为停止态，使实际挂载与 Compose 一致。" >&2
    return 1
  fi

  _container_bind_rows=$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Type "bind"}}{{printf "XJM_BIND\t%s\t%s\n" .Source .Destination}}{{end}}{{end}}' \
    "$_container_id" 2>/dev/null) || {
    echo "❌ 无法枚举 app 容器全部实际 bind mounts；不能证明 host-only 控制面不可见。" >&2
    return 1
  }
  if printf '%s\n' "$_container_bind_rows" | awk -F '\t' \
    'NF && ($1 != "XJM_BIND" || NF != 3 || $2 == "" || $3 == "") { bad = 1 } END { exit bad ? 0 : 1 }'; then
    echo "❌ app 容器实际 bind mount 输出格式异常；恢复已中止。" >&2
    return 1
  fi
  _container_bind_sources=$(printf '%s\n' "$_container_bind_rows" | awk -F '\t' '$1 == "XJM_BIND" { print $2 }')
  validate_control_not_exposed_by_binds "app 容器实际" "$_container_bind_sources" || return 1

  _data_identity=$(path_identity "$_requested_data_abs") || return 1
  if [ -n "$RESTORE_DATA_IDENTITY" ] && [ "$_data_identity" != "$RESTORE_DATA_IDENTITY" ]; then
    echo "❌ DATA_DIR 物理 dev/inode 已变化，拒绝继续恢复。" >&2
    echo "   Captured: $RESTORE_DATA_IDENTITY" >&2
    echo "   Current:  $_data_identity" >&2
    return 1
  fi
  if [ -n "$RESTORE_COMPOSE_DATA_ABS" ] && [ "$_compose_data_abs" != "$RESTORE_COMPOSE_DATA_ABS" ]; then
    echo "❌ Compose /app/data bind source 已变化，拒绝继续恢复。" >&2
    return 1
  fi
  if [ -n "$RESTORE_CONTAINER_DATA_ABS" ] && [ "$_container_data_abs" != "$RESTORE_CONTAINER_DATA_ABS" ]; then
    echo "❌ 已捕获容器的 /app/data mount source 已变化，拒绝继续恢复。" >&2
    return 1
  fi
  if [ -z "$RESTORE_CONTAINER_WAS_RUNNING" ]; then
    _container_was_running=$(docker inspect --format '{{.State.Running}}' "$_container_id" 2>/dev/null) || {
      echo "❌ 无法读取已捕获 app 容器的初始运行态；恢复已中止。" >&2
      return 1
    }
    case "$_container_was_running" in
      true|false) RESTORE_CONTAINER_WAS_RUNNING="$_container_was_running" ;;
      *)
        echo "❌ 已捕获 app 容器的初始运行态格式异常，拒绝继续恢复。" >&2
        return 1
        ;;
    esac
  fi
  _container_image=$(docker inspect --format '{{.Image}}' "$_container_id" 2>/dev/null) || {
    echo "❌ 无法读取已捕获 app 容器的镜像身份。" >&2
    return 1
  }
  if ! printf '%s\n' "$_container_image" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    echo "❌ app 容器镜像身份格式异常，拒绝继续恢复。" >&2
    return 1
  fi
  if [ -n "$RESTORE_CONTAINER_IMAGE" ] && [ "$_container_image" != "$RESTORE_CONTAINER_IMAGE" ]; then
    echo "❌ 已捕获 app 容器的镜像身份已变化，拒绝继续恢复。" >&2
    return 1
  fi
  _compose_labels=$(docker inspect --format \
    '{{index .Config.Labels "com.docker.compose.project"}}{{printf "\t"}}{{index .Config.Labels "com.docker.compose.service"}}{{printf "\t"}}{{index .Config.Labels "com.docker.compose.oneoff"}}{{printf "\t"}}{{index .Config.Labels "com.docker.compose.config-hash"}}' \
    "$_container_id" 2>/dev/null) || {
    echo "❌ 无法读取已捕获 app 容器的 Compose project/service 身份。" >&2
    return 1
  }
  _compose_project=$(printf '%s\n' "$_compose_labels" | awk -F '\t' 'NF == 4 { print $1 }')
  _compose_service=$(printf '%s\n' "$_compose_labels" | awk -F '\t' 'NF == 4 { print $2 }')
  _compose_oneoff=$(printf '%s\n' "$_compose_labels" | awk -F '\t' 'NF == 4 { print $3 }')
  _container_config_hash=$(printf '%s\n' "$_compose_labels" | awk -F '\t' 'NF == 4 { print $4 }')
  if ! printf '%s\n' "$_compose_project" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' || \
     [ "$_compose_service" != "app" ] || [ "$_compose_oneoff" != "False" ]; then
    echo "❌ app 容器缺少可靠的 Compose project/service/non-oneoff 身份标签。" >&2
    return 1
  fi
  if [ "$_container_config_hash" != "$_compose_config_hash" ]; then
    echo "❌ 已捕获 app 容器的 Compose config hash 与当前配置不一致；请先 recreate 为停止态。" >&2
    return 1
  fi
  if [ -n "$RESTORE_COMPOSE_PROJECT" ] && [ "$_compose_project" != "$RESTORE_COMPOSE_PROJECT" ]; then
    echo "❌ 已捕获 app 容器的 Compose project 身份已变化，拒绝继续恢复。" >&2
    return 1
  fi
  if [ -n "$RESTORE_COMPOSE_SERVICE" ] && [ "$_compose_service" != "$RESTORE_COMPOSE_SERVICE" ]; then
    echo "❌ 已捕获 app 容器的 Compose service 身份已变化，拒绝继续恢复。" >&2
    return 1
  fi

  # `docker compose ps` 只代表 Compose 当前指针；并发 recreate 或手工保留的旧实例可能仍带着同一
  # project/service/non-oneoff 标签，却不再出现在该指针里。恢复期间任何第二个语义 app 都可能用旧库
  # readiness 冒充目标实例，或在发布窗口继续接流量，因此必须把标签枚举与当前指针合并后要求唯一。
  _service_label_ids=$(docker ps -a --no-trunc -q \
    --filter "label=com.docker.compose.project=$_compose_project" \
    --filter "label=com.docker.compose.service=$_compose_service" \
    --filter "label=com.docker.compose.oneoff=False" 2>/dev/null) || {
    echo "❌ 无法枚举同一 Compose project/service 的 app 容器；恢复已中止。" >&2
    return 1
  }
  _service_ids=$(printf '%s\n%s\n' "$_container_ids" "$_service_label_ids" | awk 'NF && !seen[$0]++')
  _service_count=$(printf '%s\n' "$_service_ids" | awk 'NF { count++ } END { print count + 0 }')
  _service_only=$(printf '%s\n' "$_service_ids" | awk 'NF { print; exit }')
  if [ "$_service_count" -ne 1 ] || [ "$_service_only" != "$_container_id" ]; then
    echo "❌ 检测到额外或漂移的同 project/service app 容器，拒绝继续恢复。" >&2
    echo "   Captured/current: $_container_id" >&2
    printf '   Candidate: %s\n' $_service_ids >&2
    return 1
  fi

  # 后续锁、marker、app.db 操作只使用已经核验过的物理绝对路径，避免 symlink 在校验后换靶。
  DATA_DIR="$_requested_data_abs"
  if [ "$BACKUP_DIR_IS_DEFAULT" = "1" ]; then
    BACKUP_DIR="$DATA_DIR/backups"
  fi
  MARKER="$DATA_DIR/.upgrade-in-progress"
  DB="$DATA_DIR/app.db"
  RESTORE_CONTAINER_ID="$_container_id"
  RESTORE_DATA_IDENTITY="$_data_identity"
  RESTORE_COMPOSE_DATA_ABS="$_compose_data_abs"
  RESTORE_CONTAINER_DATA_ABS="$_container_data_abs"
  RESTORE_CONTAINER_IMAGE="$_container_image"
  RESTORE_COMPOSE_PROJECT="$_compose_project"
  RESTORE_COMPOSE_SERVICE="$_compose_service"
  RESTORE_COMPOSE_CONFIG_HASH="$_compose_config_hash"
}

verify_restore_identity() {
  _phase="$1"
  if validate_compose_data_bind; then
    return 0
  fi
  IDENTITY_DRIFTED=1
  echo "🛑 容器/挂载/DATA_DIR 身份在${_phase}发生漂移；拒绝继续，实例将保持停止。" >&2
  return 1
}

verify_captured_container_stopped() {
  _stopped_phase="$1"
  _running=$(docker inspect --format '{{.State.Running}}' "$RESTORE_CONTAINER_ID" 2>/dev/null || true)
  if [ "$_running" != "false" ]; then
    IDENTITY_DRIFTED=1
    echo "❌ 已捕获 app 容器在${_stopped_phase}并非停止态；拒绝让 app 接触已校验 stage。" >&2
    return 1
  fi
}

verify_captured_container_isolated() {
  _isolated_phase="$1"
  _isolated_network_ids=$(read_container_network_ids) || {
    IDENTITY_DRIFTED=1
    echo "❌ 无法在${_isolated_phase}确认已捕获 app 容器的网络集合；拒绝继续。" >&2
    return 1
  }
  if printf '%s\n' "$_isolated_network_ids" | awk 'NF { found = 1 } END { exit found ? 0 : 1 }'; then
    IDENTITY_DRIFTED=1
    echo "❌ 已捕获 app 容器在${_isolated_phase}不再处于零网络隔离态；拒绝接受 readiness。" >&2
    return 1
  fi
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

state_file_exists() {
  $SUDO test -f "$1"
}

state_dir_exists() {
  $SUDO test -d "$1"
}

state_path_exists() {
  $SUDO test -e "$1"
}

state_symlink_exists() {
  $SUDO test -L "$1"
}

read_restore_state() {
  $SUDO cat -- "$1" 2>/dev/null || true
}

read_restore_state_strict() {
  $SUDO cat -- "$1" 2>/dev/null
}

read_linux_boot_id() {
  _linux_boot_id=$($SUDO cat -- /proc/sys/kernel/random/boot_id 2>/dev/null) || return 1
  printf '%s\n' "$_linux_boot_id" \
    | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
    || return 1
  printf '%s\n' "$_linux_boot_id"
}

read_linux_process_start_ticks() {
  _linux_pid="$1"
  case "$_linux_pid" in 0|*[!0-9]*|'') return 1 ;; esac
  _linux_stat=$($SUDO cat -- "/proc/$_linux_pid/stat" 2>/dev/null) || return 1
  _linux_ticks=$(printf '%s\n' "$_linux_stat" | awk -v expected_pid="$_linux_pid" '
    NR == 1 {
      if (index($0, expected_pid " (") != 1) invalid = 1
      line = $0
      sub(/^.*\) /, "", line)
      count = split(line, fields, /[[:space:]]+/)
      if (count < 20 || fields[20] !~ /^[0-9]+$/) invalid = 1
      ticks = fields[20]
      next
    }
    { invalid = 1 }
    END {
      if (NR != 1 || invalid) exit 1
      print ticks
    }
  ') || return 1
  printf '%s\n' "$_linux_ticks"
}

read_linux_process_presence() {
  _linux_presence_pid="$1"
  case "$_linux_presence_pid" in 0|*[!0-9]*|'') return 1 ;; esac
  _linux_pid_paths=$($SUDO find /proc \
    -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -print 2>/dev/null) || return 1
  _linux_presence=$(printf '%s\n' "$_linux_pid_paths" | awk -v expected="/proc/$_linux_presence_pid" '
    NF {
      records++
      if ($0 !~ /^\/proc\/[0-9]+$/) invalid = 1
      if ($0 == "/proc/1") init++
      if ($0 == expected) found++
    }
    END {
      if (invalid || records == 0 || init != 1 || found > 1) exit 1
      print (found == 1 ? "present" : "absent")
    }
  ') || return 1
  printf '%s\n' "$_linux_presence"
}

read_darwin_process_identity() {
  _darwin_pid="$1"
  case "$_darwin_pid" in 0|*[!0-9]*|'') return 1 ;; esac
  _darwin_record=$($SUDO env LC_ALL=C ps -o uid= -o lstart= -p "$_darwin_pid" 2>/dev/null | awk '
    NF >= 6 {
      count++
      uid = $1
      $1 = ""
      sub(/^[[:space:]]+/, "", $0)
      start = $0
    }
    END {
      if (count != 1 || uid !~ /^[0-9]+$/ || start == "") exit 1
      print uid "\t" start
    }
  ') || return 1
  _darwin_uid=$(printf '%s\n' "$_darwin_record" | awk -F '\t' '{ print $1 }')
  _darwin_start=$(printf '%s\n' "$_darwin_record" | awk -F '\t' '{ print $2 }')
  _darwin_checksum=$(printf '%s' "$_darwin_start" | cksum | awk '
    NR == 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print $1 ":" $2; valid = 1; next }
    { invalid = 1 }
    END { if (!valid || invalid || NR != 1) exit 1 }
  ') || return 1
  printf '%s %s\n' "$_darwin_uid" "$_darwin_checksum"
}

process_start_fingerprint() {
  _fingerprint_pid="$1"
  case "$_fingerprint_pid" in 0|*[!0-9]*|'') return 1 ;; esac
  _fingerprint_platform=$(uname -s 2>/dev/null) || return 1
  case "$_fingerprint_platform" in
    Linux)
      _fingerprint_boot_id=$(read_linux_boot_id) || return 1
      _fingerprint_start_ticks=$(read_linux_process_start_ticks "$_fingerprint_pid") || return 1
      printf 'v2 linux-proc %s %s\n' "$_fingerprint_boot_id" "$_fingerprint_start_ticks"
      ;;
    Darwin)
      _fingerprint_darwin=$(read_darwin_process_identity "$_fingerprint_pid") || return 1
      _fingerprint_uid=$(printf '%s\n' "$_fingerprint_darwin" | awk '{ print $1 }')
      _fingerprint_checksum=$(printf '%s\n' "$_fingerprint_darwin" | awk '{ print $2 }')
      printf 'v2 darwin-ps %s %s\n' "$_fingerprint_uid" "$_fingerprint_checksum"
      ;;
    *)
      return 1
      ;;
  esac
}

parse_owner_fingerprint() {
  _owner_parsed=$(printf '%s\n' "$1" | awk '
    NR == 1 && NF == 4 && $1 == "v2" && ($2 == "linux-proc" || $2 == "darwin-ps") {
      print $2 "\t" $3 "\t" $4
      valid = 1
      next
    }
    { invalid = 1 }
    END { if (NR != 1 || !valid || invalid) exit 1 }
  ') || return 1
  PARSED_OWNER_KIND=$(printf '%s\n' "$_owner_parsed" | awk -F '\t' '{ print $1 }')
  PARSED_OWNER_FIELD1=$(printf '%s\n' "$_owner_parsed" | awk -F '\t' '{ print $2 }')
  PARSED_OWNER_FIELD2=$(printf '%s\n' "$_owner_parsed" | awk -F '\t' '{ print $3 }')
  case "$PARSED_OWNER_KIND" in
    linux-proc)
      printf '%s\n' "$PARSED_OWNER_FIELD1" \
        | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
        || return 1
      printf '%s\n' "$PARSED_OWNER_FIELD2" | grep -Eq '^[0-9]+$' || return 1
      ;;
    darwin-ps)
      printf '%s\n' "$PARSED_OWNER_FIELD1" | grep -Eq '^[0-9]+$' || return 1
      printf '%s\n' "$PARSED_OWNER_FIELD2" | grep -Eq '^[0-9]+:[0-9]+$' || return 1
      ;;
    *) return 1 ;;
  esac
}

parse_accepted_state() {
  _accepted_parsed=$(printf '%s\n' "$1" | awk '
    NR == 1 && NF == 4 && $1 == "v2" {
      print $2 "\t" $3 "\t" $4
      valid = 1
      next
    }
    { invalid = 1 }
    END { if (NR != 1 || !valid || invalid) exit 1 }
  ') || return 1
  PARSED_ACCEPTED_CONTAINER_ID=$(printf '%s\n' "$_accepted_parsed" | awk -F '\t' '{ print $1 }')
  PARSED_ACCEPTED_COMPOSE_PROJECT=$(printf '%s\n' "$_accepted_parsed" | awk -F '\t' '{ print $2 }')
  PARSED_ACCEPTED_COMPOSE_SERVICE=$(printf '%s\n' "$_accepted_parsed" | awk -F '\t' '{ print $3 }')
  printf '%s\n' "$PARSED_ACCEPTED_CONTAINER_ID" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$PARSED_ACCEPTED_COMPOSE_PROJECT" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' || return 1
  printf '%s\n' "$PARSED_ACCEPTED_COMPOSE_SERVICE" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' || return 1
}

write_restore_state() {
  _state_file="$1"
  _state_value="$2"
  _state_dir=$(dirname -- "$_state_file") || return 1
  _state_base=$(basename -- "$_state_file") || return 1
  $SUDO sh -c '
    set -eu
    state_dir=$1
    state_base=$2
    state_value=$3
    umask 077
    state_tmp=$(mktemp "$state_dir/.${state_base}.tmp.XXXXXX")
    trap '\''rm -f "$state_tmp"'\'' EXIT HUP INT TERM
    printf "%s\n" "$state_value" > "$state_tmp"
    chmod 600 "$state_tmp"
    mv -- "$state_tmp" "$state_dir/$state_base"
    trap - EXIT HUP INT TERM
  ' restore-state "$_state_dir" "$_state_base" "$_state_value"
}

# Linux 上若宿主调用者与 app 都是 uid1000，且显式禁用 sudo，那么 DATA_DIR 内的同文件系统 stage
# 无法与 app 隔离。macOS Docker Desktop 的宿主 uid 与 VM uid 映射不同，继续支持 SUDO= 路径。
if [ "$(uname -s 2>/dev/null || true)" != "Darwin" ] && \
   [ "$CALLER_UID" = "1000" ] && [ -z "$SUDO" ]; then
  echo "❌ Linux uid1000 调用者不能用 SUDO= 运行 restore：app 也是 uid1000，无法隔离已校验 stage。" >&2
  echo "   请保留默认 sudo（或直接以 root 运行），以便 stage 在 replace 前保持 app 不可写。" >&2
  exit 2
fi

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

# 残锁必须早于 Compose 当前指针校验处理：上次 restore 若在 app-started 后被 SIGKILL，Compose 可能
# 已被并发 recreate 到 B。此时先按锁内捕获的精确 A ID 停实例，再报告人工处理；不能先因 A/B 不匹配
# 退出、把尚未 network-published 的实例继续留在线上。
DATA_DIR=$(absdir "$DATA_DIR") || exit 1
if [ "$BACKUP_DIR_IS_DEFAULT" = "1" ]; then BACKUP_DIR="$DATA_DIR/backups"; fi
MARKER="$DATA_DIR/.upgrade-in-progress"
DB="$DATA_DIR/app.db"
EARLY_RESTORE_LOCK="$DATA_DIR/.restore-in-progress"
EARLY_RESTORE_CONTROL="${DATA_DIR}.restore-control"
EARLY_CONTROL_ACCEPTED_HANDOFF="${DATA_DIR}.restore-control-accepted"
EARLY_PUBLISHED_COMPOSE_PROJECT=""
EARLY_PUBLISHED_COMPOSE_SERVICE=""

if state_symlink_exists "$EARLY_RESTORE_CONTROL" || state_symlink_exists "$EARLY_CONTROL_ACCEPTED_HANDOFF"; then
  echo "❌ host-only restore 控制路径不能是符号链接：$EARLY_RESTORE_CONTROL" >&2
  exit 4
fi

classify_early_restore_owner() {
  EARLY_OWNER_STATE="unknown"
  EARLY_OWNER_DETAIL="owner PID/指纹缺失、格式无效或不可读取"
  _owner_pid=$(read_restore_state_strict "$EARLY_RESTORE_CONTROL/owner-pid") || return 0
  case "$_owner_pid" in 0|*[!0-9]*|'') return 0 ;; esac
  _owner_fingerprint=$(read_restore_state_strict "$EARLY_RESTORE_CONTROL/owner-start-fingerprint") || return 0
  parse_owner_fingerprint "$_owner_fingerprint" || return 0
  _owner_platform=$(uname -s 2>/dev/null) || {
    EARLY_OWNER_DETAIL="无法确认宿主平台"
    return 0
  }

  case "$PARSED_OWNER_KIND" in
    linux-proc)
      if [ "$_owner_platform" != "Linux" ]; then
        EARLY_OWNER_DETAIL="锁内是 Linux /proc 指纹，但当前宿主不是 Linux"
        return 0
      fi
      _current_boot_id=$(read_linux_boot_id) || {
        EARLY_OWNER_DETAIL="无法经提权路径读取 Linux boot_id"
        return 0
      }
      if [ "$_current_boot_id" != "$PARSED_OWNER_FIELD1" ]; then
        EARLY_OWNER_STATE="stale"
        EARLY_OWNER_DETAIL="boot_id 已变化，锁内 owner 属于此前启动周期"
        return 0
      fi
      if _current_start_ticks=$(read_linux_process_start_ticks "$_owner_pid"); then
        if [ "$_current_start_ticks" = "$PARSED_OWNER_FIELD2" ]; then
          EARLY_OWNER_STATE="live"
          EARLY_OWNER_DETAIL="PID、boot_id 与 /proc starttime ticks 均匹配"
        else
          EARLY_OWNER_STATE="stale"
          EARLY_OWNER_DETAIL="PID 存在但 /proc starttime ticks 不匹配（PID reuse）"
        fi
        return 0
      fi

      # stat 读取失败不能直接等价为 ESRCH：hidepid/权限拒绝同样会失败。沿同一 $SUDO/直接读取
      # 通道严格枚举一层 /proc PID 目录，且要求稳定的 PID 1 恰好出现一次；只有完整枚举成功、
      # 目标 PID 明确缺席时才算 definitely stale。枚举失败、PID 仍出现或格式异常一律 unknown。
      if _linux_presence=$(read_linux_process_presence "$_owner_pid"); then
        case "$_linux_presence" in
          absent)
            EARLY_OWNER_STATE="stale"
            EARLY_OWNER_DETAIL="完整 /proc PID 枚举明确确认 owner 已不存在"
            ;;
          present)
            EARLY_OWNER_DETAIL="owner PID 仍存在，但 /proc stat 无法读取或权限不足"
            ;;
          *) EARLY_OWNER_DETAIL="Linux /proc PID 枚举格式异常，无法确认 owner" ;;
        esac
      else
        EARLY_OWNER_DETAIL="Linux /proc PID 枚举失败或权限不足，无法确认 owner"
      fi
      ;;
    darwin-ps)
      if [ "$_owner_platform" != "Darwin" ]; then
        EARLY_OWNER_DETAIL="锁内是 Darwin ps 指纹，但当前宿主不是 Darwin"
        return 0
      fi
      if _current_owner_fingerprint=$(process_start_fingerprint "$_owner_pid"); then
        if [ "$_current_owner_fingerprint" = "$_owner_fingerprint" ]; then
          EARLY_OWNER_STATE="live"
          EARLY_OWNER_DETAIL="PID、UID 与 Darwin 启动时间指纹均匹配"
        else
          EARLY_OWNER_STATE="stale"
          EARLY_OWNER_DETAIL="PID 存在但 Darwin 启动时间指纹不匹配（PID reuse）"
        fi
        return 0
      fi
      if [ "$CALLER_UID" = "0" ] || [ -n "$SUDO" ] || [ "$CALLER_UID" = "$PARSED_OWNER_FIELD1" ]; then
        # `ps -p` 的 rc=1 既可能是 PID 不存在，也可能是 sudo 认证/权限失败，不能据此判 stale。
        # 只有同一观察通道成功枚举完整 PID 列表、且严格确认目标缺席时，才算 definitely stale。
        if _darwin_pid_list=$($SUDO env LC_ALL=C ps -axo pid= 2>/dev/null); then
          _darwin_presence=$(printf '%s\n' "$_darwin_pid_list" | awk -v expected="$_owner_pid" '
            NF {
              records++
              if (NF != 1 || $1 !~ /^[0-9]+$/) invalid = 1
              if ($1 == 1) init++
              if ($1 == expected) found++
            }
            END {
              if (invalid || records == 0 || init != 1 || found > 1) exit 1
              print (found == 1 ? "present" : "absent")
            }
          ') || _darwin_presence="unknown"
          case "$_darwin_presence" in
            present) EARLY_OWNER_DETAIL="owner PID 仍存在，但 Darwin 启动时间指纹不可读取" ;;
            absent)
              EARLY_OWNER_STATE="stale"
              EARLY_OWNER_DETAIL="提权后的 Darwin PID 枚举明确确认 owner 已不存在"
              ;;
            *) EARLY_OWNER_DETAIL="Darwin PID 枚举格式异常，无法确认 owner" ;;
          esac
        else
          EARLY_OWNER_DETAIL="Darwin ps/sudo 查询失败，无法确认 owner"
        fi
      else
        EARLY_OWNER_DETAIL="跨 UID Darwin owner 无提权观测能力"
      fi
      ;;
  esac
}

container_absence_is_confirmed() {
  _absent_target="$1"
  _absent_matches=$(docker ps -a -q --no-trunc --filter "id=$_absent_target" 2>/dev/null) || return 1
  ! printf '%s\n' "$_absent_matches" | awk 'NF { found = 1 } END { exit found ? 0 : 1 }'
}

early_restore_is_published() {
  EARLY_PUBLISHED_CONTAINER_ID=""
  EARLY_PUBLISHED_COMPOSE_PROJECT=""
  EARLY_PUBLISHED_COMPOSE_SERVICE=""
  if state_file_exists "$EARLY_CONTROL_ACCEPTED_HANDOFF"; then
    _published_handoff=$(read_restore_state "$EARLY_CONTROL_ACCEPTED_HANDOFF")
    parse_accepted_state "$_published_handoff" || return 1
  else
    state_file_exists "$EARLY_RESTORE_CONTROL/ready-accepted" || return 1
    state_file_exists "$EARLY_RESTORE_CONTROL/network-published" || return 1
    _published_accepted=$(read_restore_state "$EARLY_RESTORE_CONTROL/ready-accepted")
    _published_network=$(read_restore_state "$EARLY_RESTORE_CONTROL/network-published")
    [ "$_published_accepted" = "$_published_network" ] || return 1
    parse_accepted_state "$_published_accepted" || return 1
  fi
  EARLY_PUBLISHED_CONTAINER_ID="$PARSED_ACCEPTED_CONTAINER_ID"
  EARLY_PUBLISHED_COMPOSE_PROJECT="$PARSED_ACCEPTED_COMPOSE_PROJECT"
  EARLY_PUBLISHED_COMPOSE_SERVICE="$PARSED_ACCEPTED_COMPOSE_SERVICE"
  if state_file_exists "$EARLY_RESTORE_CONTROL/container-id"; then
    [ "$(read_restore_state "$EARLY_RESTORE_CONTROL/container-id")" = "$EARLY_PUBLISHED_CONTAINER_ID" ] || return 1
  fi
}

early_stop_and_isolate() {
  _early_target="$1"
  [ -n "$_early_target" ] || return 1
  if ! docker inspect "$_early_target" >/dev/null 2>&1; then
    if container_absence_is_confirmed "$_early_target"; then
      return 0
    fi
    echo "❌ 无法通过 Docker inspect 确认容器状态：$_early_target" >&2
    return 1
  fi
  docker stop "$_early_target" >/dev/null 2>&1 || true
  [ "$(docker inspect --format '{{.State.Running}}' "$_early_target" 2>/dev/null || true)" = "false" ] || return 1
  _early_network_ids=$(docker inspect --format \
    '{{range $settings := .NetworkSettings.Networks}}{{printf "%s\n" $settings.NetworkID}}{{end}}' \
    "$_early_target" 2>/dev/null) || return 1
  for _early_network_id in $_early_network_ids; do
    docker network disconnect -f "$_early_network_id" "$_early_target" >/dev/null 2>&1 || true
  done
  _early_remaining=$(docker inspect --format \
    '{{range $settings := .NetworkSettings.Networks}}{{printf "%s\n" $settings.NetworkID}}{{end}}' \
    "$_early_target" 2>/dev/null) || return 1
  ! printf '%s\n' "$_early_remaining" | awk 'NF { found = 1 } END { exit found ? 0 : 1 }'
}

early_restore_service_container_ids() {
  _early_project=$(read_restore_state "$EARLY_RESTORE_CONTROL/compose-project")
  _early_service=$(read_restore_state "$EARLY_RESTORE_CONTROL/compose-service")
  if ! printf '%s\n' "$_early_project" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' || \
     ! printf '%s\n' "$_early_service" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'; then
    _early_project="$EARLY_PUBLISHED_COMPOSE_PROJECT"
    _early_service="$EARLY_PUBLISHED_COMPOSE_SERVICE"
  fi
  _early_label_ids=""
  if printf '%s\n' "$_early_project" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' && \
     printf '%s\n' "$_early_service" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'; then
    _early_label_ids=$(docker ps -a --no-trunc -q \
      --filter "label=com.docker.compose.project=$_early_project" \
      --filter "label=com.docker.compose.service=$_early_service" \
      --filter "label=com.docker.compose.oneoff=False" 2>/dev/null) || return 1
  fi
  _early_compose_ids=$(docker compose ps --all --no-trunc -q app 2>/dev/null) || return 1
  printf '%s\n%s\n' "$_early_label_ids" "$_early_compose_ids" | awk 'NF && !seen[$0]++'
}

persist_early_published_ambiguity() {
  if ! state_dir_exists "$EARLY_RESTORE_CONTROL"; then
    if state_path_exists "$EARLY_RESTORE_CONTROL" || state_symlink_exists "$EARLY_RESTORE_CONTROL"; then
      return 1
    fi
    $SUDO mkdir -m 700 "$EARLY_RESTORE_CONTROL" || return 1
  fi
  $SUDO chmod 700 "$EARLY_RESTORE_CONTROL" || return 1
  write_restore_state \
    "$EARLY_RESTORE_CONTROL/ambiguous-publication" \
    "v2 $EARLY_PUBLISHED_CONTAINER_ID $EARLY_PUBLISHED_COMPOSE_PROJECT $EARLY_PUBLISHED_COMPOSE_SERVICE"
}

early_unpublished_restore_requires_containment() {
  state_file_exists "$EARLY_RESTORE_CONTROL/ready-accepted" || \
    state_file_exists "$EARLY_RESTORE_CONTROL/networks-reconnecting" || \
    state_file_exists "$EARLY_RESTORE_CONTROL/ambiguous-publication" || \
    state_file_exists "$EARLY_RESTORE_CONTROL/publication-failed" || \
    state_file_exists "$EARLY_RESTORE_CONTROL/app-started" || \
    state_file_exists "$EARLY_RESTORE_CONTROL/networks-isolated" || \
    state_file_exists "$EARLY_RESTORE_CONTROL/sidecars-clean" || \
    state_file_exists "$EARLY_RESTORE_CONTROL/upgrade-marker-clean" || \
    { state_file_exists "$EARLY_RESTORE_CONTROL/replace-armed" && \
      ! state_path_exists "$EARLY_RESTORE_LOCK/snapshot.db"; }
}

report_early_owner_unknown() {
  echo "   ❌ 无法安全确认锁内 owner 是否仍存活：${EARLY_OWNER_DETAIL}。" >&2
  echo "   为避免把跨 UID/权限受限的活跃 restore 误判为 stale，本次不停止容器、不改网络或 accepted 状态。" >&2
}

if state_path_exists "$EARLY_RESTORE_CONTROL" || state_file_exists "$EARLY_CONTROL_ACCEPTED_HANDOFF" || \
   state_dir_exists "$EARLY_RESTORE_LOCK"; then
  echo "🛑 已有另一个 restore 或上次异常中断的状态锁：$EARLY_RESTORE_LOCK" >&2
  classify_early_restore_owner
  _early_owner_metadata_present=0
  if state_file_exists "$EARLY_RESTORE_CONTROL/owner-pid" || \
     state_file_exists "$EARLY_RESTORE_CONTROL/owner-start-fingerprint"; then
    _early_owner_metadata_present=1
  fi
  _early_handoff_without_owner=0
  if [ "$_early_owner_metadata_present" = "0" ] && state_file_exists "$EARLY_CONTROL_ACCEPTED_HANDOFF"; then
    _early_handoff_without_owner=1
  fi

  if [ "$EARLY_OWNER_STATE" = "live" ]; then
    echo "   状态显示：锁内 owner 仍存活且指纹匹配；按并发 restore 处理，不干扰其容器。" >&2
  elif [ "$EARLY_OWNER_STATE" = "unknown" ] && [ "$_early_handoff_without_owner" = "0" ]; then
    report_early_owner_unknown
  elif early_restore_is_published; then
    _published_cleanup_failed=0
    _published_container_exists=1
    if ! docker inspect "$EARLY_PUBLISHED_CONTAINER_ID" >/dev/null 2>&1; then
      if container_absence_is_confirmed "$EARLY_PUBLISHED_CONTAINER_ID"; then
        _published_container_exists=0
      else
        _published_cleanup_failed=1
      fi
    fi
    _published_candidate_ids=$(early_restore_service_container_ids) || _published_cleanup_failed=1
    for _published_candidate_id in $_published_candidate_ids; do
      [ "$_published_candidate_id" = "$EARLY_PUBLISHED_CONTAINER_ID" ] && continue
      early_stop_and_isolate "$_published_candidate_id" || _published_cleanup_failed=1
    done
    if [ "$_published_cleanup_failed" = "0" ]; then
      if [ "$_published_container_exists" = "1" ]; then
        echo "   状态显示：readiness 与 network-published 已确认；保留 exact 已验收实例，并停止/隔离其他 service 候选。" >&2
      else
        echo "   状态显示：已验收 exact 容器已不存在；其他未验收 service 候选已停止/隔离。" >&2
      fi
    else
      if ! persist_early_published_ambiguity; then
        echo "   ❌ 无法把 published 残锁的不确定状态持久化到 host-only control。" >&2
      fi
      echo "   ❌ 已发布残锁的 Docker 状态无法完整确认；请立即核对 exact 与替代实例。" >&2
    fi
  elif [ "$EARLY_OWNER_STATE" = "unknown" ]; then
    report_early_owner_unknown
  elif early_unpublished_restore_requires_containment; then
    _stale_stop_failed=0
    _stale_container_id=$(read_restore_state "$EARLY_RESTORE_CONTROL/container-id")
    if printf '%s\n' "$_stale_container_id" | grep -Eq '^[0-9a-f]{64}$'; then
      early_stop_and_isolate "$_stale_container_id" || _stale_stop_failed=1
    else
      _stale_stop_failed=1
    fi
    _stale_current_ids=$(early_restore_service_container_ids) || _stale_stop_failed=1
    for _stale_current_id in $_stale_current_ids; do
      [ -n "$_stale_current_id" ] || continue
      if [ "$_stale_current_id" != "$_stale_container_id" ]; then
        early_stop_and_isolate "$_stale_current_id" || _stale_stop_failed=1
      fi
    done
    if [ "$_stale_stop_failed" = "0" ]; then
      if state_file_exists "$EARLY_RESTORE_CONTROL/ready-accepted"; then
        if state_file_exists "$EARLY_RESTORE_CONTROL/ambiguous-publication"; then
          echo "   状态显示：readiness 已接受但上次网络发布结果不明；已精确停止并撤回当前 endpoint。" >&2
        elif state_file_exists "$EARLY_RESTORE_CONTROL/networks-reconnecting"; then
          echo "   状态显示：readiness 已接受但 network-published 未提交；已精确停止并隔离实例。" >&2
        else
          echo "   状态显示：readiness 已接受但尚未发布网络；已按锁内精确 ID 停止并隔离实例。" >&2
        fi
      elif state_file_exists "$EARLY_RESTORE_CONTROL/sidecars-clean" || \
           state_file_exists "$EARLY_RESTORE_CONTROL/upgrade-marker-clean" || \
           { state_file_exists "$EARLY_RESTORE_CONTROL/replace-armed" && \
             ! state_path_exists "$EARLY_RESTORE_LOCK/snapshot.db"; }; then
        echo "   状态显示：数据库已替换但 app 尚未验收；已按锁内精确 ID 停止并隔离实例。" >&2
      else
        echo "   状态显示：app 曾启动或可能启动但尚未接受；已按锁内精确 ID 停止并隔离实例。" >&2
      fi
    else
      echo "   ❌ 无法确认所有未发布实例均已停止/隔离；请立即检查 Docker 状态。" >&2
    fi
  elif state_file_exists "$EARLY_RESTORE_CONTROL/replace-armed" && ! state_path_exists "$EARLY_RESTORE_LOCK/snapshot.db"; then
    echo "   状态显示：数据库可能已替换，但旧 WAL/SHM 与后续阶段尚待确认；保持 app 停止。" >&2
  elif state_file_exists "$EARLY_RESTORE_CONTROL/replace-armed"; then
    echo "   状态显示：替换已武装但私有 stage 仍在，数据库大概率尚未替换；仍需人工核对。" >&2
  else
    echo "   状态显示：中断发生在 app 启动前；未干扰可能仍在执行的 restore 进程。" >&2
  fi
  echo "   restore 锁与阶段证据保持原样，请核对数据库/日志后人工处置。" >&2
  exit 4
fi

validate_compose_data_bind

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
#    为停止态；数据库恢复完成前严禁 up/start。当前安全 restore.sh 必须先复制到
#    checkout 外保留。
if [ -f "$MARKER" ] && [ "$AFTER_ROLLBACK" -eq 0 ]; then
  cat >&2 <<EOF
🛑 检测到未完结的升级标记：$MARKER
   直接恢复会白做：新镜像启动时见 schema 落后，会拿还原后的旧库重跑同一个失败迁移。
   正确顺序：
     1) RECOVERY_SH="\$(mktemp)"; install -m 700 "$0" "\$RECOVERY_SH"
     2) docker compose stop app
     3) 把代码/镜像退回旧版本（git checkout <旧提交/tag>，或改 compose 切回旧镜像 tag）
     4) docker compose build app
     5) docker compose create --force-recreate app   # 只重建为停止态，绝不运行 entrypoint
     6) "\$RECOVERY_SH" --after-image-rollback <升级前快照路径>
        成功后：rm -f "\$RECOVERY_SH"
   🔴 第 6 步前禁止 docker compose up/start；否则旧服务会在旧库恢复前启动并可能写入中间 schema。
EOF
  exit 3
fi

echo "→ 恢复源：$SNAPSHOT"
echo "→ 目标库：$DB"

# 🔴 restore 互斥 + 进程间状态分成两层：DATA_DIR 内只保留停机期同文件系统 stage；
# 真正的身份、隔离、accepted 与 network-published 证据位于未挂进 app 的宿主 sibling
# 控制目录。Compose 与容器所有 bind source 都会先检查，不能包含该 sibling。
#
# 1) `mkdir` 是跨进程原子的：同一 DATA_DIR 同时只能有一个 restore，避免两个进程共享临时恢复源 /
#    pre-restore.tmp 后互相覆盖、rename，进而破坏“stage 是否仍存在”的状态判据。
# 2) 源快照先固化到 host-only 控制目录并校验；停机后再复制到 DATA_DIR 内 `snapshot.db`，用 cmp +
#    header + quick_check 二次确认。app 运行时看不到预校验副本，本地 stage 在 mv 前也不交给 uid1000。
# 3) `replace-armed` 在最终 mv 前创建；它与本地 snapshot.db 是否仍存在共同编码进程可见阶段：
#      armed + stage 存在   → mv 未成功，当前 DB/WAL 必须保留；
#      armed + stage 不存在 → mv 已成功，旧 WAL/SHM 必须清掉后才能 start。
#    因为状态在文件系统 namespace 里，进程被 SIGKILL 后锁目录仍会阻止下一次 restore，并给出
#    人工恢复线索。这里没有 fsync 屏障，**不承诺宿主断电后的元数据持久顺序**；见 docs §5.2。
RESTORE_LOCK="$DATA_DIR/.restore-in-progress"
RESTORE_CONTROL_LOCK="${DATA_DIR}.restore-control"
RESTORE_CONTROL_ACCEPTED_HANDOFF="${DATA_DIR}.restore-control-accepted"
RESTORE_VALIDATED_SNAPSHOT="$RESTORE_CONTROL_LOCK/snapshot.db"
RESTORE_CONTROL_ARMED_MARKER="$RESTORE_CONTROL_LOCK/replace-armed"
RESTORE_CONTROL_SIDECARS_CLEAN_MARKER="$RESTORE_CONTROL_LOCK/sidecars-clean"
RESTORE_CONTROL_UPGRADE_MARKER_CLEAN_MARKER="$RESTORE_CONTROL_LOCK/upgrade-marker-clean"
RESTORE_CONTROL_APP_STARTED_MARKER="$RESTORE_CONTROL_LOCK/app-started"
RESTORE_CONTROL_READY_BODY="$RESTORE_CONTROL_LOCK/ready-body"
RESTORE_CONTROL_NETWORKS_FILE="$RESTORE_CONTROL_LOCK/container-networks"
RESTORE_CONTROL_NETWORKS_ISOLATED_MARKER="$RESTORE_CONTROL_LOCK/networks-isolated"
RESTORE_CONTROL_NETWORKS_RECONNECTING_MARKER="$RESTORE_CONTROL_LOCK/networks-reconnecting"
RESTORE_CONTROL_NETWORK_PUBLISHED="$RESTORE_CONTROL_LOCK/network-published"
RESTORE_CONTROL_AMBIGUOUS_PUBLICATION="$RESTORE_CONTROL_LOCK/ambiguous-publication"
RESTORE_CONTROL_PUBLICATION_FAILED="$RESTORE_CONTROL_LOCK/publication-failed"
RESTORE_STAGE="$RESTORE_LOCK/snapshot.db"
RESTORE_CONTROL_READY_ACCEPTED="$RESTORE_CONTROL_LOCK/ready-accepted"
RESTORE_CONTROL_OWNER_PID_FILE="$RESTORE_CONTROL_LOCK/owner-pid"
RESTORE_CONTROL_OWNER_START_FINGERPRINT_FILE="$RESTORE_CONTROL_LOCK/owner-start-fingerprint"
RESTORE_CONTROL_CONTAINER_ID_FILE="$RESTORE_CONTROL_LOCK/container-id"
RESTORE_CONTROL_COMPOSE_PROJECT_FILE="$RESTORE_CONTROL_LOCK/compose-project"
RESTORE_CONTROL_COMPOSE_SERVICE_FILE="$RESTORE_CONTROL_LOCK/compose-service"
RESTORE_CONTROL_DATA_IDENTITY_FILE="$RESTORE_CONTROL_LOCK/data-identity"
RESTORE_CONTROL_CONTAINER_SOURCE_FILE="$RESTORE_CONTROL_LOCK/container-data-source"
RESTORE_CONTROL_CONTAINER_IMAGE_FILE="$RESTORE_CONTROL_LOCK/container-image"
RESTORE_CONTROL_CONTAINER_WAS_RUNNING_FILE="$RESTORE_CONTROL_LOCK/container-was-running"
PRE_RESTORE_TMP="$BACKUP_DIR/pre-restore.db.tmp"
READY_BODY_TMP=""
LOCK_HELD=0
STOP_ATTEMPTED=0
RELEASE_FAILED=0

accepted_state_value() {
  printf 'v2 %s %s %s\n' \
    "$RESTORE_CONTAINER_ID" "$RESTORE_COMPOSE_PROJECT" "$RESTORE_COMPOSE_SERVICE"
}

restore_is_published() {
  _published_expected=$(accepted_state_value)
  if state_file_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF"; then
    [ "$(read_restore_state "$RESTORE_CONTROL_ACCEPTED_HANDOFF")" = "$_published_expected" ]
    return
  fi
  state_file_exists "$RESTORE_CONTROL_READY_ACCEPTED" || return 1
  state_file_exists "$RESTORE_CONTROL_NETWORK_PUBLISHED" || return 1
  [ "$(read_restore_state "$RESTORE_CONTROL_READY_ACCEPTED")" = "$_published_expected" ] || return 1
  [ "$(read_restore_state "$RESTORE_CONTROL_NETWORK_PUBLISHED")" = "$_published_expected" ]
}

remove_restore_control_contents() {
  $SUDO rm -f \
    "$RESTORE_VALIDATED_SNAPSHOT" \
    "$RESTORE_CONTROL_ARMED_MARKER" \
    "$RESTORE_CONTROL_SIDECARS_CLEAN_MARKER" \
    "$RESTORE_CONTROL_UPGRADE_MARKER_CLEAN_MARKER" \
    "$RESTORE_CONTROL_APP_STARTED_MARKER" \
    "$RESTORE_CONTROL_READY_BODY" \
    "$RESTORE_CONTROL_NETWORKS_FILE" \
    "$RESTORE_CONTROL_NETWORKS_ISOLATED_MARKER" \
    "$RESTORE_CONTROL_NETWORKS_RECONNECTING_MARKER" \
    "$RESTORE_CONTROL_NETWORK_PUBLISHED" \
    "$RESTORE_CONTROL_AMBIGUOUS_PUBLICATION" \
    "$RESTORE_CONTROL_PUBLICATION_FAILED" \
    "$RESTORE_CONTROL_OWNER_PID_FILE" \
    "$RESTORE_CONTROL_OWNER_START_FINGERPRINT_FILE" \
    "$RESTORE_CONTROL_CONTAINER_ID_FILE" \
    "$RESTORE_CONTROL_COMPOSE_PROJECT_FILE" \
    "$RESTORE_CONTROL_COMPOSE_SERVICE_FILE" \
    "$RESTORE_CONTROL_DATA_IDENTITY_FILE" \
    "$RESTORE_CONTROL_CONTAINER_SOURCE_FILE" \
    "$RESTORE_CONTROL_CONTAINER_IMAGE_FILE" \
    "$RESTORE_CONTROL_CONTAINER_WAS_RUNNING_FILE" \
    "$RESTORE_CONTROL_READY_ACCEPTED"
}

release_restore_control() {
  if ! state_dir_exists "$RESTORE_CONTROL_LOCK"; then
    return 0
  fi

  _control_expected=$(accepted_state_value)
  if state_file_exists "$RESTORE_CONTROL_READY_ACCEPTED" && state_file_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF"; then
    echo "❌ trusted ready-accepted 与 control handoff 同时存在，拒绝释放控制锁。" >&2
    return 1
  fi
  if ! restore_is_published; then
    echo "❌ host-only 控制面尚未完成 network-published，拒绝释放。" >&2
    return 1
  fi
  if state_file_exists "$RESTORE_CONTROL_READY_ACCEPTED"; then
    if state_path_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF" || state_symlink_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF"; then
      echo "❌ host-only accepted handoff 已存在，拒绝覆盖或移入未知目录。" >&2
      return 1
    fi
    if ! $SUDO chmod 600 "$RESTORE_CONTROL_READY_ACCEPTED" || \
       ! $SUDO mv -- "$RESTORE_CONTROL_READY_ACCEPTED" "$RESTORE_CONTROL_ACCEPTED_HANDOFF"; then
      echo "❌ 无法把 trusted accepted 原子交接到 host-only handoff。" >&2
      return 1
    fi
  elif [ "$(read_restore_state "$RESTORE_CONTROL_ACCEPTED_HANDOFF")" != "$_control_expected" ]; then
    echo "❌ host-only accepted handoff 内容不匹配，拒绝释放。" >&2
    return 1
  fi

  if ! remove_restore_control_contents; then
    echo "❌ 无法清理 host-only restore 控制状态：$RESTORE_CONTROL_LOCK" >&2
    return 1
  fi
  if ! $SUDO rmdir "$RESTORE_CONTROL_LOCK"; then
    echo "❌ 无法释放 host-only restore 控制锁；trusted handoff/目录保留。" >&2
    return 1
  fi
}

discard_unreplaced_restore_control() {
  [ "${1:-}" = "confirmed-unreplaced" ] || {
    echo "❌ 缺少换库前状态证明，拒绝丢弃 restore 控制锁。" >&2
    return 1
  }
  if ! state_dir_exists "$RESTORE_CONTROL_LOCK"; then
    return 0
  fi

  # cleanup 已在删除 public stage **之前**用 armed+stage 判据固化 `_post_replace=0`。public stage 随后
  # 被删除，不能在这里再次用“armed + stage absent”重算，否则会把我们自己的清理误判成 mv 已成功。
  # 仍显式拒绝任何只可能出现在 post-replace/accepted/published 的阶段，避免未来误用本函数。
  if restore_was_accepted || \
     state_file_exists "$RESTORE_CONTROL_SIDECARS_CLEAN_MARKER" || \
     state_file_exists "$RESTORE_CONTROL_UPGRADE_MARKER_CLEAN_MARKER" || \
     state_file_exists "$RESTORE_CONTROL_APP_STARTED_MARKER" || \
     state_file_exists "$RESTORE_CONTROL_NETWORKS_ISOLATED_MARKER" || \
     state_file_exists "$RESTORE_CONTROL_NETWORKS_RECONNECTING_MARKER" || \
     state_file_exists "$RESTORE_CONTROL_NETWORK_PUBLISHED" || \
     state_file_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF"; then
    echo "❌ restore 已进入换库或发布阶段，拒绝按未替换路径清理控制锁。" >&2
    return 1
  fi
  if ! remove_restore_control_contents; then
    echo "❌ 无法清理未替换 restore 的临时控制状态：$RESTORE_CONTROL_LOCK" >&2
    return 1
  fi
  if ! $SUDO rmdir "$RESTORE_CONTROL_LOCK"; then
    echo "❌ 无法释放未替换 restore 的 host-only 控制锁：$RESTORE_CONTROL_LOCK" >&2
    return 1
  fi
}

clear_restore_control_handoff() {
  state_file_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF" || return 0
  if ! $SUDO rm -f "$RESTORE_CONTROL_ACCEPTED_HANDOFF"; then
    echo "❌ restore 已完成但无法清理 host-only accepted handoff；它会继续阻断下一次 restore。" >&2
    return 1
  fi
}

release_public_restore_lock() {
  [ "$LOCK_HELD" = "1" ] || return 0
  if ! state_dir_exists "$RESTORE_LOCK"; then
    LOCK_HELD=0
    return
  fi

  # public 目录只在捕获容器已确认停止时存在；app start 前清空并 rmdir。app 运行后 shell 不再
  # 通过 DATA_DIR 下的 pathname 读写任何状态，所有授权/诊断均由 host-only control 承担。
  if ! $SUDO rm -f "$RESTORE_STAGE"; then
    echo "❌ 无法清理停机期 public restore stage：$RESTORE_LOCK" >&2
    return 1
  fi
  if ! $SUDO rmdir "$RESTORE_LOCK"; then
    echo "❌ 无法释放停机期 public restore stage：${RESTORE_LOCK}（请确认目录内无未知文件）" >&2
    return 1
  fi
  LOCK_HELD=0
}

release_restore_lock() {
  release_public_restore_lock || return 1
  release_restore_control || return 1
  clear_restore_control_handoff
}

db_was_replaced() {
  state_file_exists "$RESTORE_CONTROL_SIDECARS_CLEAN_MARKER" ||
    state_file_exists "$RESTORE_CONTROL_UPGRADE_MARKER_CLEAN_MARKER" ||
    state_file_exists "$RESTORE_CONTROL_APP_STARTED_MARKER" ||
    state_file_exists "$RESTORE_CONTROL_READY_ACCEPTED" ||
    state_file_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF" ||
    { state_file_exists "$RESTORE_CONTROL_ARMED_MARKER" && ! state_path_exists "$RESTORE_STAGE"; }
}

sidecars_are_clean() {
  state_file_exists "$RESTORE_CONTROL_SIDECARS_CLEAN_MARKER" ||
    state_file_exists "$RESTORE_CONTROL_UPGRADE_MARKER_CLEAN_MARKER" ||
    state_file_exists "$RESTORE_CONTROL_APP_STARTED_MARKER" ||
    state_file_exists "$RESTORE_CONTROL_READY_ACCEPTED"
}

restore_was_accepted() {
  state_file_exists "$RESTORE_CONTROL_READY_ACCEPTED" ||
    state_file_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF"
}

validate_replayable_container_networks() {
  _network_endpoint_details=$(docker inspect --format \
    '{{range $name, $settings := .NetworkSettings.Networks}}{{with $settings.IPAMConfig}}{{if .IPv4Address}}{{printf "%s\tstatic-ipv4\n" $name}}{{end}}{{if .IPv6Address}}{{printf "%s\tstatic-ipv6\n" $name}}{{end}}{{with .LinkLocalIPs}}{{printf "%s\tlink-local\n" $name}}{{end}}{{end}}{{with $settings.DriverOpts}}{{printf "%s\tdriver-opts\n" $name}}{{end}}{{with $settings.Links}}{{printf "%s\tlinks\n" $name}}{{end}}{{if ne $settings.GwPriority 0}}{{printf "%s\tgw-priority\t%d\n" $name $settings.GwPriority}}{{end}}{{end}}' \
    "$RESTORE_CONTAINER_ID" 2>/dev/null) || {
    echo "❌ 无法核对已捕获 app 容器的网络端点配置。" >&2
    return 1
  }

  # 运行态 endpoint MAC 是 Docker 动态属性，不是恢复身份；方案 A 只固化 NetworkID/name/aliases。
  # 显式 MAC 已在 Compose 配置层拒绝，这里继续拒绝其他无法无损重放的端点参数。
  if printf '%s\n' "$_network_endpoint_details" | awk 'NF { found = 1 } END { exit found ? 0 : 1 }'; then
    echo "❌ app 容器网络含 restore 无法无损重放的静态/自定义端点配置：" >&2
    printf '   %s\n' "$_network_endpoint_details" >&2
    echo "   当前恢复器只支持动态 endpoint 与 network aliases；已在停机前 fail-closed。" >&2
    return 1
  fi
}

read_container_network_manifest() {
  _manifest_rows=$(docker inspect --format \
    '{{range $name, $settings := .NetworkSettings.Networks}}{{printf "XJM_NETWORK_RECORD\t%s\t%s" $name $settings.NetworkID}}{{range $settings.Aliases}}{{printf "\t%s" .}}{{end}}{{printf "\n"}}{{end}}' \
    "$RESTORE_CONTAINER_ID" 2>/dev/null) || return 1
  printf '%s\n' "$_manifest_rows" | awk -F '\t' '
    NF {
      if ($1 != "XJM_NETWORK_RECORD" || NF < 3) exit 1
      if ($2 == "" || $2 !~ /^[A-Za-z0-9_.-]+$/) exit 1
      if (length($3) != 64 || $3 ~ /[^0-9a-f]/) exit 1
      for (i = 4; i <= NF; i++) {
        if ($i == "" || $i !~ /^[A-Za-z0-9_.-]+$/) exit 1
      }
      for (i = 2; i <= NF; i++) {
        printf "%s%s", (i == 2 ? "" : "\t"), $i
      }
      printf "\n"
      found = 1
    }
    END { if (!found) exit 1 }
  '
}

read_container_network_ids() {
  _network_id_rows=$(docker inspect --format \
    '{{range $settings := .NetworkSettings.Networks}}{{printf "XJM_NETWORK_ID\t%s\n" $settings.NetworkID}}{{end}}' \
    "$RESTORE_CONTAINER_ID" 2>/dev/null) || return 1
  printf '%s\n' "$_network_id_rows" | awk -F '\t' '
    NF {
      if ($1 != "XJM_NETWORK_ID" || NF != 2 || length($2) != 64 || $2 ~ /[^0-9a-f]/) exit 1
      print $2
    }
  '
}

capture_container_networks() {
  validate_replayable_container_networks || return 1
  _network_manifest=$(read_container_network_manifest) || {
    echo "❌ 无法读取已捕获 app 容器的网络身份。" >&2
    return 1
  }
  write_restore_state "$RESTORE_CONTROL_NETWORKS_FILE" "$_network_manifest" || return 1
}

disconnect_container_networks() {
  _disconnect_force="${1:-0}"
  state_file_exists "$RESTORE_CONTROL_NETWORKS_FILE" || return 1
  _network_manifest=$(read_restore_state "$RESTORE_CONTROL_NETWORKS_FILE")
  _captured_ids=$(printf '%s\n' "$_network_manifest" | awk -F '\t' 'NF { print $2 }')
  _current_ids=$(read_container_network_ids) || return 1
  _disconnect_ids=$(printf '%s\n%s\n' "$_captured_ids" "$_current_ids" | awk 'NF' | sort -u)
  for _network_id in $_disconnect_ids; do
    if [ "$_disconnect_force" = "1" ]; then
      docker network disconnect -f "$_network_id" "$RESTORE_CONTAINER_ID" >/dev/null 2>&1 || true
    else
      docker network disconnect "$_network_id" "$RESTORE_CONTAINER_ID" >/dev/null 2>&1 || true
    fi
  done
  _remaining_ids=$(read_container_network_ids) || return 1
  if printf '%s\n' "$_remaining_ids" | awk 'NF { found = 1 } END { exit found ? 0 : 1 }'; then
    echo "❌ 无法确认已捕获容器完全断网。" >&2
    return 1
  fi
  write_restore_state "$RESTORE_CONTROL_NETWORKS_ISOLATED_MARKER" "" || return 1
}

reconnect_container_networks() {
  state_file_exists "$RESTORE_CONTROL_NETWORKS_FILE" || return 1
  _network_manifest=$(read_restore_state "$RESTORE_CONTROL_NETWORKS_FILE")
  while IFS= read -r _network_line; do
    _network_name=$(printf '%s\n' "$_network_line" | awk -F '\t' '{ print $1 }')
    _network_id=$(printf '%s\n' "$_network_line" | awk -F '\t' '{ print $2 }')
    [ -n "$_network_name" ] || continue
    set -- docker network connect
    _network_aliases=$(printf '%s\n' "$_network_line" | awk -F '\t' '{ for (i = 3; i <= NF; i++) print $i }')
    for _network_alias in $_network_aliases; do
      set -- "$@" --alias "$_network_alias"
    done
    set -- "$@" "$_network_id" "$RESTORE_CONTAINER_ID"
    "$@" >/dev/null || return 1
  done <<EOF
$_network_manifest
EOF
  verify_container_network_manifest "网络重连后"
}

normalize_network_manifest() {
  awk -F '\t' '
    NF {
      print "N\t" $1 "\t" $2
      for (i = 3; i <= NF; i++) print "A\t" $1 "\t" $i
    }
  ' | sort
}

verify_container_network_manifest() {
  _manifest_phase="$1"
  _actual_manifest=$(read_container_network_manifest) || {
    echo "❌ ${_manifest_phase}无法读取 endpoint 身份。" >&2
    return 1
  }
  _expected_manifest=$(read_restore_state "$RESTORE_CONTROL_NETWORKS_FILE")
  _expected_normalized=$(printf '%s\n' "$_expected_manifest" | normalize_network_manifest)
  _actual_normalized=$(printf '%s\n' "$_actual_manifest" | normalize_network_manifest)
  if [ "$_expected_normalized" != "$_actual_normalized" ]; then
    echo "❌ ${_manifest_phase}的 NetworkID/name/aliases 与捕获清单不一致。" >&2
    return 1
  fi
}

probe_captured_readiness() {
  _probe_timeout="$1"
  docker exec --user 0:0 "$RESTORE_CONTAINER_ID" node -e '
    const timeoutMs = Number(process.argv[1]) * 1000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    fetch("http://127.0.0.1:3000/api/ready", { redirect: "manual", signal: controller.signal })
      .then(async (response) => {
        process.stdout.write(Buffer.from(await response.arrayBuffer()))
        if (response.status !== 200) process.exitCode = 8
      })
      .catch(() => { process.exitCode = 7 })
      .finally(() => clearTimeout(timer))
  ' "$_probe_timeout"
}

ready_body_is_ok() {
  # body 直接从 0600 文件按原始字节读取，绝不经过无法保存 NUL 的 shell 变量。固定响应契约只有
  # 单字段对象 {"ok":true}；token 间只允许 JSON 的 space/tab/CR/LF，任何额外字节都拒绝。
  LC_ALL=C $SUDO od -An -v -t u1 "$1" 2>/dev/null | awk '
    function is_ws(byte) {
      return byte == 32 || byte == 9 || byte == 10 || byte == 13
    }
    function skip_ws() {
      while (cursor <= count && is_ws(bytes[cursor])) cursor++
    }
    function expect(byte) {
      if (cursor > count || bytes[cursor] != byte) return 0
      cursor++
      return 1
    }
    {
      for (field = 1; field <= NF; field++) bytes[++count] = $field
    }
    END {
      cursor = 1
      skip_ws()
      ok = expect(123) # {
      skip_ws()
      ok = ok && expect(34) && expect(111) && expect(107) && expect(34) # "ok"
      skip_ws()
      ok = ok && expect(58) # :
      skip_ws()
      ok = ok && expect(116) && expect(114) && expect(117) && expect(101) # true
      skip_ws()
      ok = ok && expect(125) # }
      skip_ws()
      ok = ok && cursor > count
      exit ok ? 0 : 1
    }
  '
}

clean_replaced_sidecars() {
  # sidecars-clean 或更晚阶段存在时，app 可能已为新库创建自己的 WAL；绝不能重复删除。
  sidecars_are_clean && return 0
  # armed 不存在＝尚未进入替换，绝不能碰当前库可能承载已提交数据的 WAL。
  state_file_exists "$RESTORE_CONTROL_ARMED_MARKER" || return 0
  # stage 仍在＝最终 mv 尚未成功，app.db/WAL 仍属于当前库，必须原样保留。
  ! state_path_exists "$RESTORE_STAGE" || return 0
  if ! $SUDO rm -f "$DB-wal" "$DB-shm"; then
    echo "❌ 数据库已替换，但无法删除旧 WAL/SHM；为防混库，拒绝重启 app。" >&2
    echo "   请保持 app 停止，修复权限后删除：$DB-wal $DB-shm。" >&2
    return 1
  fi
  # host-only marker 在 app 不可见的目录内原子推进。信号若落在 sidecar 删除与
  # marker rename 之间，app 仍未启动；cleanup 重复 rm -f 是幂等且不会碰新库 WAL。
  if ! $SUDO mv -- "$RESTORE_CONTROL_ARMED_MARKER" "$RESTORE_CONTROL_SIDECARS_CLEAN_MARKER"; then
    echo "❌ 旧 WAL/SHM 已删除，但无法推进 host-only sidecars-clean 阶段；拒绝重启 app。" >&2
    return 1
  fi
}

container_network_ids_for() {
  docker inspect --format \
    '{{range $settings := .NetworkSettings.Networks}}{{printf "%s\n" $settings.NetworkID}}{{end}}' \
    "$1" 2>/dev/null
}

stop_and_isolate_container() {
  _target_id="$1"
  [ -n "$_target_id" ] || return 1
  if ! docker inspect "$_target_id" >/dev/null 2>&1; then
    if container_absence_is_confirmed "$_target_id"; then
      return 0
    fi
    echo "❌ 无法通过 Docker inspect 确认容器状态：$_target_id" >&2
    return 1
  fi
  docker stop "$_target_id" >/dev/null 2>&1 || true
  if [ "$(docker inspect --format '{{.State.Running}}' "$_target_id" 2>/dev/null || true)" != "false" ]; then
    echo "❌ 无法确认容器已停止：$_target_id" >&2
    return 1
  fi
  _target_network_ids=$(container_network_ids_for "$_target_id") || return 1
  for _target_network_id in $_target_network_ids; do
    docker network disconnect -f "$_target_network_id" "$_target_id" >/dev/null 2>&1 || true
  done
  _remaining_target_networks=$(container_network_ids_for "$_target_id") || return 1
  if printf '%s\n' "$_remaining_target_networks" | awk 'NF { found = 1 } END { exit found ? 0 : 1 }'; then
    echo "❌ 容器已停止，但无法确认其流量网络已撤回：$_target_id" >&2
    return 1
  fi
}

restore_service_container_ids() {
  _label_ids=$(docker ps -a --no-trunc -q \
    --filter "label=com.docker.compose.project=$RESTORE_COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=$RESTORE_COMPOSE_SERVICE" \
    --filter "label=com.docker.compose.oneoff=False" 2>/dev/null) || {
    echo "❌ 无法枚举同一 Compose project/service 的 app 容器；不能证明所有候选已收口。" >&2
    return 1
  }
  _compose_ids=$(docker compose ps --all --no-trunc -q app 2>/dev/null) || {
    echo "❌ 无法读取 Compose 当前 app 指针；不能证明所有候选已收口。" >&2
    return 1
  }
  printf '%s\n%s\n' "$_label_ids" "$_compose_ids" | awk 'NF && !seen[$0]++'
}

stop_unpublished_restore_targets() {
  _stop_failed=0
  _service_ids=""
  if ! _service_ids=$(restore_service_container_ids); then
    _stop_failed=1
  fi
  _target_ids=$(printf '%s\n%s\n' "$RESTORE_CONTAINER_ID" "$_service_ids" | awk 'NF && !seen[$0]++')
  for _target_id in $_target_ids; do
    [ -n "$_target_id" ] || continue
    if ! stop_and_isolate_container "$_target_id"; then
      _stop_failed=1
    fi
  done
  [ "$_stop_failed" = "0" ]
}

stop_drifted_extra_targets() {
  _stop_failed=0
  _service_ids=$(restore_service_container_ids) || return 1
  for _target_id in $_service_ids; do
    [ -n "$_target_id" ] || continue
    [ "$_target_id" = "$RESTORE_CONTAINER_ID" ] && continue
    if ! stop_and_isolate_container "$_target_id"; then
      _stop_failed=1
    fi
  done
  [ "$_stop_failed" = "0" ]
}

cleanup_restore() {
  _exit_rc=$?
  trap - EXIT INT TERM
  _keep_lock=0
  _post_replace=0

  if db_was_replaced; then
    _post_replace=1
    if ! clean_replaced_sidecars; then
      _keep_lock=1
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
    fi
  fi

  if [ "$IDENTITY_DRIFTED" = "1" ]; then
    _keep_lock=1
    if restore_is_published; then
      if ! stop_drifted_extra_targets; then
        [ "$_exit_rc" -ne 0 ] || _exit_rc=1
        write_restore_state "$RESTORE_CONTROL_AMBIGUOUS_PUBLICATION" "$(accepted_state_value)" || true
        echo "🛑 无法完整枚举/收口已发布实例之外的 service 候选；发布身份状态不明。" >&2
      fi
      echo "🛑 restore 身份在 network-published 后漂移：已尝试停止未验收的替代实例，已验收实例与状态锁保留。" >&2
    elif ! stop_unpublished_restore_targets; then
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
      write_restore_state "$RESTORE_CONTROL_AMBIGUOUS_PUBLICATION" "$(accepted_state_value)" || true
    fi
    echo "🛑 restore 身份漂移：未发布实例已尝试停止/隔离，状态锁保留。" >&2
  elif restore_is_published; then
    # network-published 是唯一提交点。此后即使信号落在锁释放收尾，也不得反向停机。
    # 若主路径已尝试 release 且失败，accepted/control 必须原样保留；EXIT cleanup 不能用第二次
    # 瞬时成功把首次失败证据抹掉，留下“exit 1 但无残锁”的模糊现场。
    if [ "$RELEASE_FAILED" = "1" ]; then
      _keep_lock=1
    else
      _keep_lock=0
    fi
  elif restore_was_accepted; then
    _keep_lock=1
    # ready-accepted 先于任何 network connect 持久化。若优雅失败发生在发布过程，停止精确
    # 容器并撤回所有已见 endpoint；无法确认撤回时保留 ambiguous-publication。
    if ! stop_unpublished_restore_targets; then
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
      write_restore_state "$RESTORE_CONTROL_AMBIGUOUS_PUBLICATION" "$(accepted_state_value)" || true
    fi
    echo "🛑 readiness 已接受但 network-published 尚未提交；已尝试停止并撤回网络，accepted 证据保留。" >&2
  elif [ "$_post_replace" = "1" ]; then
    _keep_lock=1
    # 库已替换但尚未 ready/accepted：即使 start 命令可能只执行了一半，也再次 stop 并保留现场。
    # 此时绝不再 start；人工确认前锁目录持续阻断下一次 restore。
    if [ "$STOP_ATTEMPTED" = "1" ] && ! stop_unpublished_restore_targets; then
      echo "❌ restore 收尾无法确认 app 已停止；请立即保持服务隔离并人工检查。" >&2
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
    fi
    echo "🛑 数据库已替换但恢复尚未被 readiness 接受；app 保持停止，restore 锁与阶段证据已保留。" >&2
  elif [ "$STOP_ATTEMPTED" = "1" ]; then
    # 数据库尚未替换：当前 DB/WAL 仍是一体。只有 restore 开始前本来就在运行的 app 才能重启；
    # 对原本停止态（包括刚 create 出来的停止态）绝不能因失败路径把旧镜像启动到中间状态。
    if [ "$RESTORE_CONTAINER_WAS_RUNNING" = "true" ]; then
      if ! verify_restore_identity "恢复旧 app 前" || ! docker start "$RESTORE_CONTAINER_ID" >/dev/null; then
        echo "❌ restore 收尾无法安全重启已捕获 app 容器；请检查容器身份与日志。" >&2
        _keep_lock=1
        [ "$_exit_rc" -ne 0 ] || _exit_rc=1
      fi
    elif [ "$RESTORE_CONTAINER_WAS_RUNNING" = "false" ]; then
      echo "→ app 在 restore 开始前已是停止态；换库前失败后保持停止，不启动旧镜像。" >&2
    else
      echo "❌ 无法确认 app 在 restore 开始前的运行态；拒绝自动启动并保留状态锁。" >&2
      _keep_lock=1
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
    fi
  fi

  # 现场 VACUUM 的临时文件永远不是正式回滚点；优雅退出时清掉。SIGKILL 来不及清时，Node
  # 片段的 umask 077 仍保证它不是 0644 敏感副本，且状态锁会阻断下一次 restore。
  if ! $SUDO rm -f "$PRE_RESTORE_TMP"; then
    echo "❌ 无法清理现场留存临时文件：$PRE_RESTORE_TMP" >&2
    [ "$_exit_rc" -ne 0 ] || _exit_rc=1
  fi
  if [ -n "$READY_BODY_TMP" ]; then
    if ! rm -f -- "$READY_BODY_TMP"; then
      echo "⚠️ 无法清理调用者侧 readiness 临时响应：$READY_BODY_TMP" >&2
    fi
    READY_BODY_TMP=""
  fi

  if [ "$_keep_lock" = "0" ]; then
    if [ "$_post_replace" = "0" ]; then
      if ! release_public_restore_lock || ! discard_unreplaced_restore_control confirmed-unreplaced; then
        _keep_lock=1
        [ "$_exit_rc" -ne 0 ] || _exit_rc=1
      fi
    elif ! release_restore_lock; then
      _keep_lock=1
      [ "$_exit_rc" -ne 0 ] || _exit_rc=1
    fi
  fi
  if [ "$_keep_lock" != "0" ]; then
    echo "🛑 已保留 restore host-only 状态锁：${RESTORE_CONTROL_LOCK}；完成上面的人工处置后再移除。" >&2
  fi

  exit "$_exit_rc"
}

RESTORE_OWNER_START_FINGERPRINT=$(process_start_fingerprint "$$") || {
  echo "❌ 无法读取 restore owner 的进程启动指纹；恢复已中止。" >&2
  exit 1
}

if ! $SUDO mkdir "$RESTORE_CONTROL_LOCK"; then
  if state_path_exists "$RESTORE_CONTROL_LOCK" || state_file_exists "$RESTORE_CONTROL_ACCEPTED_HANDOFF"; then
    echo "🛑 已有另一个 restore 或上次异常中断的 host-only 控制锁：$RESTORE_CONTROL_LOCK" >&2
    exit 4
  fi
  echo "❌ 无法创建 host-only restore 控制锁：$RESTORE_CONTROL_LOCK" >&2
  exit 1
fi
trap cleanup_restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# host-only control 必须先于 stop/任何 public 路径取得，且始终是唯一授权状态。DATA_DIR 仍由 app
# uid1000 写入，故其中的 public 子目录即使 root-owned 也能被父目录 owner rename；app 未确认停止前
# 绝不创建或写该目录。control 与后续停机期 public stage 都保持创建者所有、0700，不 chown 给 caller。
$SUDO chmod 700 "$RESTORE_CONTROL_LOCK"
write_restore_state "$RESTORE_CONTROL_OWNER_PID_FILE" "$$" || {
  echo "❌ 无法记录 host-only restore owner PID；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_OWNER_START_FINGERPRINT_FILE" "$RESTORE_OWNER_START_FINGERPRINT" || {
  echo "❌ 无法记录 host-only restore owner 启动指纹；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_CONTAINER_ID_FILE" "$RESTORE_CONTAINER_ID" || {
  echo "❌ 无法记录 host-only app 容器 ID；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_COMPOSE_PROJECT_FILE" "$RESTORE_COMPOSE_PROJECT" || {
  echo "❌ 无法记录 Compose project 身份；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_COMPOSE_SERVICE_FILE" "$RESTORE_COMPOSE_SERVICE" || {
  echo "❌ 无法记录 Compose service 身份；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_DATA_IDENTITY_FILE" "$RESTORE_DATA_IDENTITY" || {
  echo "❌ 无法记录 DATA_DIR dev/inode 身份；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_CONTAINER_SOURCE_FILE" "$RESTORE_CONTAINER_DATA_ABS" || {
  echo "❌ 无法记录 app 容器 mount source；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_CONTAINER_IMAGE_FILE" "$RESTORE_CONTAINER_IMAGE" || {
  echo "❌ 无法记录 app 容器镜像身份；恢复已中止。" >&2
  exit 1
}
write_restore_state "$RESTORE_CONTROL_CONTAINER_WAS_RUNNING_FILE" "$RESTORE_CONTAINER_WAS_RUNNING" || {
  echo "❌ 无法记录 app 容器初始运行态；恢复已中止。" >&2
  exit 1
}
capture_container_networks || {
  echo "❌ 无法固化 app 容器网络身份；恢复已中止。" >&2
  exit 1
}

echo "→ 固化恢复源到 app 不可见的 host-only 预校验副本（0600）：$RESTORE_VALIDATED_SNAPSHOT"
if ! $SUDO install -m 600 "$SNAPSHOT_ABS" "$RESTORE_VALIDATED_SNAPSHOT"; then
  echo "❌ 无法复制恢复源到 host-only 预校验副本；app 未停、当前数据库未改动。" >&2
  exit 1
fi

# 快照必须是 SQLite 库文件——错传日志/空文件不能进入 stop/替换阶段。检查的是 app 不可见的
# host-only 固化副本；停机后同文件系统 stage 还会再次逐字节和 SQLite 校验。
if [ "$($SUDO head -c 15 "$RESTORE_VALIDATED_SNAPSHOT" 2>/dev/null || true)" != "SQLite format 3" ]; then
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
node_with_snapshot "$RESTORE_VALIDATED_SNAPSHOT" '
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

# trap 必须在 stop **之前**安装：未替换时的失败/信号会保留当前 DB/WAL 并恢复旧 app；一旦库已
# 替换但尚未 ready/accepted，收尾则再次 stop、保留锁与阶段证据，绝不自动 start 或释放锁。
verify_restore_identity "stop 前" || exit 1
STOP_ATTEMPTED=1
echo "→ 停已捕获 app 容器（释放对 app.db 的写锁）：$RESTORE_CONTAINER_ID"
docker stop "$RESTORE_CONTAINER_ID" >/dev/null
verify_restore_identity "stop 后" || exit 1
verify_captured_container_stopped "复制本地 stage 前" || exit 1

if ! $SUDO mkdir "$RESTORE_LOCK"; then
  if state_path_exists "$RESTORE_LOCK" || state_symlink_exists "$RESTORE_LOCK"; then
    echo "🛑 app 已停止，但 DATA_DIR 内 public stage 路径已被占用：$RESTORE_LOCK" >&2
    echo "   host-only control 保留本次身份；未写数据库，请核对该路径后再重试。" >&2
    exit 4
  fi
  echo "❌ 无法创建停机期 public restore stage：$RESTORE_LOCK" >&2
  exit 1
fi
LOCK_HELD=1
$SUDO chmod 700 "$RESTORE_LOCK"
verify_captured_container_stopped "public stage 初始化后" || exit 1

# 预校验副本在 host-only 控制目录，app 运行时不可读写；停机后再复制到 DATA_DIR 内同文件系统 stage。
# 该 stage 故意不 chown 给 uid1000，直到原子替换已经完成，避免外部误启动 app 时出现校验后篡改。
echo "→ 复制 host-only 已校验副本到同文件系统 replace stage"
if ! $SUDO install -m 600 "$RESTORE_VALIDATED_SNAPSHOT" "$RESTORE_STAGE"; then
  echo "❌ 无法创建同文件系统 replace stage；当前数据库未改动。" >&2
  exit 1
fi
if ! $SUDO cmp -s "$RESTORE_VALIDATED_SNAPSHOT" "$RESTORE_STAGE"; then
  echo "❌ replace stage 与 host-only 已校验副本不一致；拒绝替换数据库。" >&2
  exit 1
fi
node_with_snapshot "$RESTORE_STAGE" '
  const fs = require("fs")
  const { DatabaseSync } = require("node:sqlite")
  const fd = fs.openSync("/snap.db", "r")
  const hdr = Buffer.alloc(20)
  try { fs.readSync(fd, hdr, 0, 20, 0) } finally { fs.closeSync(fd) }
  if (hdr[18] !== 1 || hdr[19] !== 1) process.exit(2)
  const d = new DatabaseSync("file:/snap.db?immutable=1", { readOnly: true })
  try {
    const r = d.prepare("PRAGMA quick_check").get()
    if (!r || r.quick_check !== "ok") process.exit(1)
  } finally {
    d.close()
  }
' || {
  echo "❌ 停机后本地 replace stage 未通过二次 header/quick_check；当前数据库未改动。" >&2
  exit 1
}
verify_captured_container_stopped "replace stage 二次校验后" || exit 1

# 现场先存一份：单文件覆盖式，仿 preupgrade.db 的钉住模式——文件名不匹配 ^backup-.*\.db$，
# 故不进 BACKUP_KEEP 轮转集，也不会被 latestBackupDay 误当成「今天的日常备份」。
PRE_RESTORE="$BACKUP_DIR/pre-restore.db"
if [ -f "$DB" ]; then
  echo "→ 存下当前现场：${PRE_RESTORE}（覆盖上一次的同名文件）"
  # shellcheck disable=SC2086  # $OWN 需按词拆分成 -o 1000 -g 1000（或空）
  $SUDO install -d $OWN -m 700 "$BACKUP_DIR"

  # 🔴 自毁防护（P6-R2 复审必修 1）：用户跑过一次 restore 后想拿 pre-restore.db 回到最初状态，
  #    是最自然的二次反悔路径。但本步会用**当前 app.db** 重建同名文件；若仍从原路径读取，恢复源
  #    会在 install 前被覆盖。现在所有源都已在 stop 前固化到 $RESTORE_VALIDATED_SNAPSHOT，并校验，
  #    所以即使原始 SNAPSHOT 就是 pre-restore.db，本步覆盖原文件也不影响最终恢复内容。

  # 🔴 必须 VACUUM INTO，绝不能 cp/install：库跑 WAL 模式，精确 `docker stop` 发 SIGTERM 后进程
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
verify_restore_identity "数据库 replace 前" || exit 1
verify_captured_container_stopped "数据库 replace 前" || exit 1
echo "→ 原子还原已校验 stage 为 ${DB}（0600 / uid1000）"
write_restore_state "$RESTORE_CONTROL_ARMED_MARKER" "" || {
  _phase_rc=$?
  echo "❌ 无法记录 host-only replace-armed 阶段；数据库尚未替换。" >&2
  exit "$_phase_rc"
}
$SUDO mv -- "$RESTORE_STAGE" "$DB"  # DATA_DIR 内同一文件系统，rename 原子
if [ -n "$OWN" ]; then
  $SUDO chown 1000:1000 "$DB" || {
    echo "❌ 数据库已替换但无法交还 uid1000；保持 app 停止并保留 restore 锁。" >&2
    exit 1
  }
fi
$SUDO chmod 600 "$DB" || {
  echo "❌ 数据库已替换但无法确认 0600；保持 app 停止并保留 restore 锁。" >&2
  exit 1
}

# -wal/-shm 是旧库的 WAL 副本，换整库快照时必须一并删除；
# 标记也要清——手动还原＝人为终结升级链，不清则下次真升级会因「标记指向的旧快照仍在」被误判、跳过备份。
echo "→ 清理 -wal/-shm 与升级标记"
clean_replaced_sidecars
$SUDO rm -f "$MARKER" || {
  _marker_rc=$?
  echo "❌ 无法删除升级标记：${MARKER}；拒绝启动 app，保留 restore 状态供人工处理。" >&2
  exit "$_marker_rc"
}
write_restore_state "$RESTORE_CONTROL_UPGRADE_MARKER_CLEAN_MARKER" "" || {
  _phase_rc=$?
  echo "❌ 升级标记虽已删除，但无法记录 host-only upgrade-marker-clean 阶段；拒绝启动 app。" >&2
  exit "$_phase_rc"
}

# readiness 响应体必须保留原始字节（含潜在 NUL）供严格解析；shell 变量做不到。默认 sudo 路径的
# host-only control 是 root-owned 0700，普通调用者 shell 不能直接 `> ready-body`。因此先写调用者自己
# 0600 的 mktemp，再用提权 install 发布进 control；授权阶段 marker 仍全部保持 root-owned。
READY_BODY_TMP=$(umask 077; mktemp "${TMPDIR:-/tmp}/xjm-restore-ready.XXXXXX") || {
  echo "❌ 无法创建调用者侧 readiness 临时响应；拒绝启动 app。" >&2
  exit 1
}
[ -n "$READY_BODY_TMP" ] || {
  echo "❌ readiness 临时响应路径为空；拒绝启动 app。" >&2
  exit 1
}

verify_restore_identity "流量隔离前" || exit 1
verify_container_network_manifest "流量隔离前" || exit 1
echo "→ 断开已捕获 app 容器的全部网络（未 accepted 前不可接流量）"
disconnect_container_networks 0 || {
  echo "❌ 无法隔离 app 容器网络；拒绝启动。" >&2
  exit 1
}
verify_captured_container_stopped "网络隔离后" || exit 1
verify_restore_identity "start 前" || exit 1
# DATA_DIR 内 public 目录只承担停机期同文件系统 stage 与诊断镜像。app 重新运行前必须完整释放；
# 之后所有权威阶段只写 host-only control，避免 app 可写父目录上的 privileged pathname race。
release_public_restore_lock || {
  echo "❌ 无法在 app 启动前释放 public restore stage；保持 app 停止。" >&2
  exit 1
}
echo "→ 起已捕获 app 容器：$RESTORE_CONTAINER_ID"
docker start "$RESTORE_CONTAINER_ID" >/dev/null
write_restore_state "$RESTORE_CONTROL_APP_STARTED_MARKER" "" || {
  _phase_rc=$?
  echo "❌ app 已尝试启动，但无法记录 host-only app-started 阶段；将再次停机并保留 restore 锁。" >&2
  exit "$_phase_rc"
}
verify_restore_identity "start 后" || exit 1
verify_captured_container_isolated "start 后" || exit 1

# 校验：readiness 才是「恢复成功」的判据——它同时证明进程已能响应，并核对
# 常驻连接、DB_PATH 文件身份、fresh 磁盘连接与两侧 schema。单独查 liveness 只能说明
# 进程活着，不能证明常驻连接仍指向当前路径上的数据库，故不作为独立恢复门禁。
echo "→ 在网络隔离的已捕获容器内校验 /api/ready（最多等 ${READY_TIMEOUT}s）"
# 🔴 单次请求必须有界（R4-P2④，codex R6 指出）：容器内应用能建连但**永不返回响应**时（进程卡在
#    某个 await），无 AbortController 的 fetch 会在一次迭代里无限阻塞——承诺的 60s 上限失效。
#    probe_captured_readiness 把每轮容器内 fetch 钳在最多 5s，且只探测已捕获容器的 loopback。
#
# 🔴 R7-P2⑥（codex R6 指出）：上限必须是**绝对 deadline**，不能靠「迭代次数 × 预估单轮耗时」。
#    修复前是 `while [ i -lt 30 ]` + 单轮最多 5s + sleep 2：正常情况下（连接被拒、curl 立即返回）
#    单轮≈2s、30 轮≈60s 与承诺相符；但**恰好在 readiness 卡住时**（接受连接却不响应，即最需要
#    这个上限的场景）单轮变成 5+2=7s → 实际约 210s，是承诺的 3.5 倍。运维照文档等 60s 就会以为
#    脚本挂了而手动打断，而打断点可能落在 trap 之外的任意位置。
#    改法：开跑记 DEADLINE=now+60；每轮把容器内 probe 与 sleep 都钳到剩余秒数，不能让最后一轮越界。
#    上限可用 READY_TIMEOUT 覆盖（回归测试要跑「等满上限」这条路径，60s 会让整套测试慢一倍；
#    运维侧偶尔也需要放宽——冷启动慢的大库首次加载可能超 60s）。默认值仍是文档承诺的 60。
_deadline=$(( $(date +%s) + READY_TIMEOUT ))
while :; do
  verify_restore_identity "readiness probe 前" || exit 1
  verify_captured_container_isolated "readiness probe 前" || exit 1
  _now=$(date +%s)
  _remaining=$((_deadline - _now))
  [ "$_remaining" -gt 0 ] || break

  _probe_timeout=5
  if [ "$_remaining" -lt "$_probe_timeout" ]; then
    _probe_timeout="$_remaining"
  fi
  if probe_captured_readiness "$_probe_timeout" > "$READY_BODY_TMP" 2>/dev/null; then
    if ! $SUDO install -m 600 "$READY_BODY_TMP" "$RESTORE_CONTROL_READY_BODY"; then
      echo "❌ 无法把 readiness 原始响应发布到 host-only control；拒绝接受。" >&2
      exit 1
    fi
    if ready_body_is_ok "$RESTORE_CONTROL_READY_BODY"; then
      verify_restore_identity "接受 readiness 前" || exit 1
      verify_captured_container_isolated "接受 readiness 前" || exit 1
      if ! rm -f -- "$READY_BODY_TMP"; then
        echo "❌ 无法清理调用者侧 readiness 临时响应；拒绝进入 accepted 阶段。" >&2
        exit 1
      fi
      READY_BODY_TMP=""
      _accepted_value=$(accepted_state_value)
      write_restore_state "$RESTORE_CONTROL_READY_ACCEPTED" "$_accepted_value" || {
        _phase_rc=$?
        echo "❌ readiness 已返回 200 + ok=true，但无法记录 host-only ready-accepted；将停机并保留锁。" >&2
        exit "$_phase_rc"
      }
      write_restore_state "$RESTORE_CONTROL_NETWORKS_RECONNECTING_MARKER" "$_accepted_value" || {
        echo "❌ readiness 已接受但无法记录 networks-reconnecting；将停机并保留 accepted 锁。" >&2
        exit 1
      }
      echo "→ readiness 已接受；按已捕获 NetworkID + aliases 恢复精确容器网络"
      if ! reconnect_container_networks; then
        echo "❌ readiness 已接受但容器网络未能完整发布；将尝试全部撤回并保留 accepted 证据。" >&2
        if disconnect_container_networks 1 && stop_and_isolate_container "$RESTORE_CONTAINER_ID"; then
          write_restore_state "$RESTORE_CONTROL_PUBLICATION_FAILED" "$_accepted_value" || true
        else
          docker stop "$RESTORE_CONTAINER_ID" >/dev/null 2>&1 || true
          write_restore_state "$RESTORE_CONTROL_AMBIGUOUS_PUBLICATION" "$_accepted_value" || true
          echo "🛑 无法确认所有 endpoint 已撤回；实例内容已验收，但发布状态不明，必须人工处置。" >&2
        fi
        exit 1
      fi
      verify_restore_identity "网络恢复后" || exit 1
      write_restore_state "$RESTORE_CONTROL_NETWORK_PUBLISHED" "$_accepted_value" || {
        RELEASE_FAILED=1
        echo "❌ 网络已生效且身份通过，但无法记录 network-published；accepted 证据与状态锁保留。" >&2
        exit 1
      }
      verify_restore_identity "network-published 后" || exit 1
      if ! $SUDO rm -f \
        "$RESTORE_CONTROL_NETWORKS_RECONNECTING_MARKER" \
        "$RESTORE_CONTROL_NETWORKS_ISOLATED_MARKER"; then
        RELEASE_FAILED=1
        echo "❌ network-published 已记录，但无法清理中间网络阶段；状态锁保留。" >&2
        exit 1
      fi
      verify_restore_identity "控制锁释放前" || exit 1
      if ! release_restore_control; then
        RELEASE_FAILED=1
        exit 1
      fi
      if ! clear_restore_control_handoff; then
        RELEASE_FAILED=1
        exit 1
      fi
      trap - EXIT INT TERM  # 只有 network-published 且两层状态锁已释放后才撤销收尾
      echo "✅ 恢复完成：捕获容器 readiness 与身份通过，NetworkID/name/aliases 已复核并发布"
      exit 0
    fi
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
