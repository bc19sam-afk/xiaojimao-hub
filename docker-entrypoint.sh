#!/bin/sh
# 容器入口：升级安全流程「备份 → 迁移 → 启动」。
# 首次部署无库 → 跳备份直接迁移建库；升级有库 → 先备份再迁移。
# 单实例本身即锁，migrate 的 busy_timeout 兜住与 worker 的偶发并发。
set -e

DB="${DB_PATH:-/app/data/app.db}"

if [ -f "$DB" ]; then
  echo "[entrypoint] 检测到现有库，先备份"
  node scripts/backup.ts || echo "[entrypoint] 备份失败（非致命，继续）"
fi

echo "[entrypoint] 运行迁移"
node scripts/migrate.ts

echo "[entrypoint] 启动服务"
exec node server.js
