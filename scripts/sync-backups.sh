#!/bin/sh
# =============================================================================
# 异机备份同步（P6-R2，见 docs/deploy.md §5.3）
#
# 把宿主 data/backups/ 整目录 rsync 到远端。**宿主侧运行**，容器内不做 ssh
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

# -a 保权限属主时间戳（备份文件是 0600，别在传输中放宽）；-z 压缩；--partial 断点续传
# 结尾斜杠：同步**目录内容**到远端目录下。含 preupgrade.db / pre-restore.db（钉住的回滚点，一并异机保存）。
echo "→ 同步 $BACKUP_DIR/ → $REMOTE"
rsync -az --partial "$BACKUP_DIR/" "$REMOTE"
echo "✅ 同步完成（未启用 --delete：远端只增不减，清理策略见 docs/deploy.md §5.3）"
