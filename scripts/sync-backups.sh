#!/bin/sh
# =============================================================================
# 异机备份同步（P6-R2，见 docs/deploy.md §5.3）
#
# 把宿主 data/backups/ 中受控备份 pair rsync 到远端。**宿主侧运行**，容器内不做 ssh
# （容器不该持有远端私钥；镜像也没装 rsync/ssh）。
#
# 用法：
#   REMOTE=user@host:/srv/xjm-backups ./scripts/sync-backups.sh
#   ./scripts/sync-backups.sh user@host:/srv/xjm-backups     # 参数优先于 REMOTE
#   BACKUP_DIR=/opt/xjm/data/backups REMOTE=... ./scripts/sync-backups.sh
#
# 🔴 故意不加 --delete：本地按 BACKUP_KEEP（默认 7）轮转，加了 --delete 会把本地的轮转删除
#    传播到异机——异机份就退化成本地的镜像，失去「更长留存」的意义，且本地误删/被入侵删库会
#    立刻同步到备份端。异机份独立累积，**由远端自行清理**（见 docs §5.3 的远端 find -mtime 示例）。
# =============================================================================
set -eu

REMOTE="${1:-${REMOTE:-}}"
BACKUP_DIR="${BACKUP_DIR:-data/backups}"

if [ -z "$REMOTE" ]; then
  echo "用法：REMOTE=user@host:/path $0   或   $0 user@host:/path" >&2
  echo "（远端路径需已存在且可写；本地目录默认 data/backups，可用 BACKUP_DIR 覆盖）" >&2
  exit 2
fi

if [ ! -d "$BACKUP_DIR" ]; then
  echo "❌ 备份目录不存在：$BACKUP_DIR" >&2
  exit 1
fi

command -v rsync >/dev/null 2>&1 || { echo "❌ 未找到 rsync，请先安装" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ 未找到 node，无法验证备份 manifest" >&2; exit 1; }

# 先把可枚举的受控 pair 固化到私有临时目录，再复核副本。这样本地 BACKUP_KEEP
# 正好在同步期间轮转删除/替换源文件，也不会让远端得到 payload/manifest 跨世代组合。
# 枚举范围只含本项目生成的 backup-*.db 及两个钉住回滚点；.tmp-* 和任意裸 .db 不进入传输集。
BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd -P)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/xjm-backup-sync.XXXXXX")
chmod 700 "$STAGE"
PAYLOAD_LIST="$STAGE/.payloads"
MANIFEST_LIST="$STAGE/.manifests"
: > "$PAYLOAD_LIST"
: > "$MANIFEST_LIST"
chmod 600 "$PAYLOAD_LIST" "$MANIFEST_LIST"
cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM

PAIR_COUNT=0
stage_pair() {
  snapshot=$1
  name=${snapshot##*/}
  manifest="${snapshot}.manifest.json"
  if ! node scripts/backup-manifest.ts verify "$snapshot" "$manifest" "$name" >/dev/null; then
    echo "❌ 备份 pair 不完整、非常规文件或 digest/manifest 已漂移：$snapshot" >&2
    exit 1
  fi
  cp "$snapshot" "$STAGE/$name"
  cp "$manifest" "$STAGE/$name.manifest.json"
  chmod 600 "$STAGE/$name" "$STAGE/$name.manifest.json"
  if ! node scripts/backup-manifest.ts verify "$STAGE/$name" "$STAGE/$name.manifest.json" "$name" >/dev/null; then
    echo "❌ 备份 pair 固化期间发生并发漂移：$snapshot" >&2
    exit 1
  fi
  printf '%s\n' "$name" >> "$PAYLOAD_LIST"
  printf '%s\n' "$name.manifest.json" >> "$MANIFEST_LIST"
  PAIR_COUNT=$((PAIR_COUNT + 1))
}

for snapshot in "$BACKUP_DIR"/backup-*.db "$BACKUP_DIR"/preupgrade.db "$BACKUP_DIR"/pre-restore.db; do
  [ -e "$snapshot" ] || [ -L "$snapshot" ] || continue
  stage_pair "$snapshot"
done

# manifest-only 是半发布或不完整删除；即使其他 pair 有效，也在联络远端前整体 fail closed。
for manifest in "$BACKUP_DIR"/backup-*.db.manifest.json "$BACKUP_DIR"/preupgrade.db.manifest.json "$BACKUP_DIR"/pre-restore.db.manifest.json; do
  [ -e "$manifest" ] || [ -L "$manifest" ] || continue
  snapshot=${manifest%.manifest.json}
  if [ ! -e "$snapshot" ] && [ ! -L "$snapshot" ]; then
    echo "❌ 发现缺少 payload 的孤立 manifest：$manifest" >&2
    exit 1
  fi
done

if [ "$PAIR_COUNT" -eq 0 ]; then
  echo "❌ 没有可同步的完整备份 pair：$BACKUP_DIR" >&2
  exit 1
fi

# -a 保留固化副本的 0600 权限；-z 压缩。--partial-dir 使中断 payload 只留在隐藏目录。
# pair 的远端提交顺序是 payload-first / manifest-last：第一阶段失败不会发布 manifest；
# 第二阶段失败最多留下无 manifest 的 payload，restore 必须拒绝。不使用 --delete；远端保留清理
# 也必须先删 manifest 提交标志，再删同名 payload。
echo "→ 同步 $PAIR_COUNT 个备份 pair：$BACKUP_DIR/ → $REMOTE"
rsync -az --partial-dir=.rsync-partial --files-from="$PAYLOAD_LIST" "$STAGE/" "$REMOTE"
rsync -az --partial-dir=.rsync-partial --files-from="$MANIFEST_LIST" "$STAGE/" "$REMOTE"
echo "✅ 同步完成（payload 先于 manifest；未启用 --delete）"
