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
#   DATA_DIR     宿主数据目录，默认 data
#   BACKUP_DIR   备份目录，默认 $DATA_DIR/backups
#   APP_URL      校验地址，默认 http://127.0.0.1:3000
# =============================================================================
set -eu

DATA_DIR="${DATA_DIR:-data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
APP_URL="${APP_URL:-http://127.0.0.1:3000}"
MARKER="$DATA_DIR/.upgrade-in-progress"
DB="$DATA_DIR/app.db"

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

echo "→ 停 app（释放对 app.db 的写锁）"
docker compose stop app

# 现场先存一份：单文件覆盖式，仿 preupgrade.db 的钉住模式——文件名不匹配 ^backup-.*\.db$，
# 故不进 BACKUP_KEEP 轮转集，也不会被 latestBackupDay 误当成「今天的日常备份」。
if [ -f "$DB" ]; then
  echo "→ 存下当前现场：$BACKUP_DIR/pre-restore.db（覆盖上一次的同名文件）"
  # shellcheck disable=SC2086  # $OWN 需按词拆分成 -o 1000 -g 1000（或空）
  $SUDO install -d $OWN -m 700 "$BACKUP_DIR"
  # 🔴 必须 VACUUM INTO，绝不能 cp/install：库跑 WAL 模式，`docker compose stop` 发 SIGTERM 后进程
  #    不做 checkpoint 就退出，最后一段已提交数据只躺在 app.db-wal 里。裸拷主文件会丢这段，而下面
  #    紧接着 `rm -f "$DB-wal"` 会把唯一副本删掉——等用户想反悔时，回滚点已残缺且不可挽回。
  #    （同 lib/backup.ts 顶部那条 WAL 安全纪律；preupgrade.db 也是 VACUUM INTO 产的。）
  #    借 app 镜像里的 node 跑：本脚本本就依赖 docker compose（上面刚 stop 过），非新依赖；
  #    用 run 而非 exec，是因为恢复常发生在容器已停/崩溃循环时，exec 那会儿连不上。
  # ⚠️ 容器内路径固定 /app/data——compose 的卷是 `./data:/app/data`，宿主侧改 DATA_DIR/BACKUP_DIR
  #    只改宿主视角，容器里挂载点不变。若你**同时改了 compose 的卷映射**，下面两个容器内路径要跟着改。
  $SUDO rm -f "$BACKUP_DIR/pre-restore.db"   # VACUUM INTO 目标已存在会报错
  docker compose run --rm --no-deps -T --entrypoint node app -e '
    const { DatabaseSync } = require("node:sqlite")
    const src = new DatabaseSync("/app/data/app.db")
    try {
      src.exec("PRAGMA busy_timeout = 5000")
      src.prepare("VACUUM INTO ?").run("/app/data/backups/pre-restore.db")
    } finally {
      src.close()
    }
  ' || {
    echo "❌ 现场留存失败：产不出 $BACKUP_DIR/pre-restore.db" >&2
    echo "   已中止，$DB 未被改动（fail-closed：没有回滚点就不做破坏性还原）。" >&2
    echo "   如确认无需回滚点，手动移开当前库后重跑：mv $DB <你的存放路径>" >&2
    exit 1
  }
  # 容器里覆盖了 entrypoint，那条 umask 077 不生效，产出可能是 0644——库含 OAuth 令牌快照与 CDK 码，收紧
  $SUDO chmod 600 "$BACKUP_DIR/pre-restore.db"
else
  echo "→ 当前无 $DB，跳过现场留存"
fi

# 一条 install 完成 覆盖还原 + 属主 uid1000 + 权限 600（不用 cp：覆盖会保留目标原 mode，
# 老部署那份 0644 收不紧、属主也不还原）
echo "→ 还原快照为 $DB（0600 / uid1000）"
# shellcheck disable=SC2086
$SUDO install $OWN -m 600 "$SNAPSHOT" "$DB"

# -wal/-shm 是旧库的 WAL 副本，换整库快照时必须一并删除；
# 标记也要清——手动还原＝人为终结升级链，不清则下次真升级会因「标记指向的旧快照仍在」被误判、跳过备份。
echo "→ 清理 -wal/-shm 与升级标记"
$SUDO rm -f "$DB-wal" "$DB-shm" "$MARKER"

echo "→ 起 app"
docker compose start app

# 校验：先 liveness（进程起来了吗），再 readiness（库能读、schema 版本对得上吗）。
# readiness 才是「恢复成功」的判据——liveness 通过但 schema 不匹配说明还原错了版本的快照。
echo "→ 校验 $APP_URL/api/health 与 /api/ready（最多等 60s）"
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS -o /dev/null "$APP_URL/api/ready" 2>/dev/null; then
    echo "✅ 恢复完成：/api/ready 通过（库可读 + schema 版本匹配）"
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
