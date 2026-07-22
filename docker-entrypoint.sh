#!/bin/sh
# 容器入口：升级安全流程「（待迁移才）备份 → 迁移 → 启动」。
# 首次部署无库 → 跳备份直接迁移建库；升级且 schema 落后 → 先备份再迁移。
# 单实例本身即锁，migrate 的 busy_timeout 兜住与 worker 的偶发并发。
set -e

# 新建文件 0600 / 目录 0700：库含 OAuth 令牌快照与 CDK 码，禁止同宿主其他用户读取。
# 放在 set -e 之后、任何建库/备份之前——覆盖 migrate 建的 app.db 及运行时 -wal/-shm。
umask 077

DB="${DB_PATH:-/app/data/app.db}"

# 升级标记：内容 = 本次升级的目标 schema 版本，落 data/ 持久卷（umask 077 下自然 0600）。
# 为何需要：migrate() 逐迁移独立提交，一次多迁移的升级若后段失败，库会停在「中间版本」；
#   restart:unless-stopped 每次重启 schema-check 都判「落后」，没有去重就每次都备份，且备的是
#   中间态——BACKUP_KEEP 轮转很快把唯一那份「升级前」快照挤掉，恰在最需要回滚时丢掉回滚点。
# 标记令「同一目标的重试」跳过备份（升级前快照已在），只有换了「新目标」才重新备份。
MARKER="$(dirname "$DB")/.upgrade-in-progress"
LATEST=$(node -e "import('./lib/migrate.ts').then((m) => console.log(m.LATEST_VERSION))")

# 仅在「库已存在且 schema 落后」时才考虑备份（schema-check 退出非 0）：
#   保住迁移前那份唯一回滚点，不被日常重启/崩溃循环反复备份 churn 掉（BACKUP_KEEP 轮转）。
if [ -f "$DB" ] && ! node scripts/schema-check.ts; then
  if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$LATEST" ]; then
    echo "[entrypoint] 同一升级（目标 v$LATEST）重试，迁移前快照已在，跳过备份"
  else
    # 顺序铁律：先备份成功、再写标记。反过来会在备份失败后把下次备份也一起跳掉。
    # 备份 fail-closed：不 || 兜底，靠 set -e——失败即中止启动，绝不带着丢失的回滚点去迁移。
    echo "[entrypoint] 检测到待迁移，先备份（备份失败即中止，保回滚点）"
    node scripts/backup.ts
    echo "$LATEST" > "$MARKER"
  fi
fi

echo "[entrypoint] 运行迁移"
node scripts/migrate.ts
# set -e 保证走到这里 = 迁移成功，本次升级闭环，清标记（下轮换了新目标才会再备份）。
rm -f "$MARKER"

echo "[entrypoint] 启动服务"
exec node server.js
