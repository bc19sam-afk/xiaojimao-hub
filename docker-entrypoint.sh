#!/bin/sh
# 容器入口：升级安全流程「（待迁移才）备份 → 迁移 → 启动」。
# 首次部署无库 → 跳备份直接迁移建库；升级且 schema 落后 → 先备份再迁移。
# 单实例本身即锁，migrate 的 busy_timeout 兜住与 worker 的偶发并发。
set -e

# 新建文件 0600 / 目录 0700：库含 OAuth 令牌快照与 CDK 码，禁止同宿主其他用户读取。
# 放在 set -e 之后、任何建库/备份之前——覆盖 migrate 建的 app.db 及运行时 -wal/-shm。
umask 077

DB="${DB_PATH:-/app/data/app.db}"

# 仅在「库已存在且 schema 落后」时备份（schema-check 退出非 0）：
#   保住迁移前那份唯一回滚点，不被日常重启/崩溃循环反复备份 churn 掉（BACKUP_KEEP 轮转）。
# 备份 fail-closed：不再 || 兜底，靠 set -e——备份失败即中止启动，绝不带着丢失的回滚点去迁移。
if [ -f "$DB" ] && ! node scripts/schema-check.ts; then
  echo "[entrypoint] 检测到待迁移，先备份（备份失败即中止，保回滚点）"
  node scripts/backup.ts
fi

echo "[entrypoint] 运行迁移"
node scripts/migrate.ts

echo "[entrypoint] 启动服务"
exec node server.js
