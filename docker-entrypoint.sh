#!/bin/sh
# 容器入口：升级安全流程「（待迁移才）备份 → 迁移 → 启动」。
# 首次部署无库 → 跳备份直接迁移建库；升级且 schema 落后 → 先备份再迁移。
# 单实例本身即锁，migrate 的 busy_timeout 兜住与 worker 的偶发并发。
set -e

# 新建文件 0600 / 目录 0700：库含 OAuth 令牌快照与 CDK 码，禁止同宿主其他用户读取。
# 放在 set -e 之后、任何建库/备份之前——覆盖 migrate 建的 app.db 及运行时 -wal/-shm。
umask 077

# MOCK 模式安全告警：口径与 lib/env.ts 的 `(MOCK ?? 'true') !== 'false'` 一致——只有恰为 false 才算非 mock，
#   缺省/任何其他值都当 MOCK。MOCK 下 /api/auth/dev-login 免鉴权发会话、trustForwardedHeaders 默认 true、
#   SESSION_SECRET 允许空——照文档默认 cp .env.example .env 直接上公网 = 免鉴权入口 + 伪造头信任。仅本机/内网预览可用。
if [ "${MOCK:-}" != "false" ]; then
  echo "⚠️ [entrypoint] MOCK 模式：/api/auth/dev-login 免鉴权发会话、默认信任 x-forwarded-* 头——仅限本机/内网预览，公网部署必须 MOCK=false"
fi

DB="${DB_PATH:-/app/data/app.db}"

# 升级标记：落 data/ 持久卷（umask 077 下自然 0600），内容 = 升级前那份快照的绝对路径。
# 为何需要：migrate() 逐迁移独立提交，一次多迁移的升级若后段失败，库会停在「中间版本」；
#   restart:unless-stopped 每次重启 schema-check 都判「落后」，没有去重就每次都备份，且备的是
#   中间态——BACKUP_KEEP 轮转很快把唯一那份「升级前」快照挤掉，恰在最需要回滚时丢掉回滚点。
# 语义：标记记录升级前快照的绝对路径；跳过备份前先验证该快照文件仍在（fail-closed）。仍在 → 沿用它作
#   回滚点、跳过备份；未完结的升级链哪怕中途换了目标版本（原目标 v12 卡住、又部署 v13 的新镜像），也共享
#   这同一份「原始升级前」快照——直到迁移成功 rm 标记才闭环。
#   为何验证存在而非「存在即跳过」：若 BACKUP_DIR 被改到非持久路径（重建即蒸发）或快照被人删，标记却还在，
#   裸「存在即跳过」会没回滚点就跑剩余迁移，违背 fail-closed。快照丢了就按当前状态重备一份（可能已是中间
#   版本，有回滚点总比没有强）。旧格式标记（内容是版本号、非路径）天然走「快照已丢」分支重新备份，兼容无需特判。
MARKER="$(dirname "$DB")/.upgrade-in-progress"
BK_DIR="${BACKUP_DIR:-/app/data/backups}"   # 与 scripts/backup.ts 默认解析一致（cwd=/app 的 data/backups）
LATEST=$(node -e "import('./lib/migrate.ts').then((m) => console.log(m.LATEST_VERSION))")   # 仅供日志

# 仅在「库已存在且 schema 落后」时才考虑备份（schema-check 退出非 0）：
#   保住迁移前那份唯一回滚点，不被日常重启/崩溃循环反复备份 churn 掉（BACKUP_KEEP 轮转）。
if [ -f "$DB" ] && ! node scripts/schema-check.ts; then
  # SNAP：标记里记的快照绝对路径（无标记则空）。`|| true` 保证 set -e 下 cat 缺失不中止。
  SNAP="$([ -f "$MARKER" ] && cat "$MARKER" || true)"
  if [ -n "$SNAP" ] && [ -f "$SNAP" ]; then
    echo "[entrypoint] 上次升级（快照 $SNAP）未完结，本次目标 v$LATEST，沿用原升级前快照，跳过备份"
  else
    # 标记在但快照已丢：告警后重新备份（echo 包进 if 块，避免 `&& echo` 在 set -e 下假失败中止启动）。
    if [ -n "$SNAP" ]; then
      echo "⚠️ [entrypoint] 标记在但快照已丢（$SNAP）——重新备份当前状态（可能已是中间版本，有回滚点总比没有强）"
    fi
    # 顺序铁律：先备份成功、再写标记。反过来会在备份失败后把下次备份也一起跳掉。
    # 备份 fail-closed：不 || 兜底，靠 set -e——失败即中止启动，绝不带着丢失的回滚点去迁移。
    echo "[entrypoint] 检测到待迁移，先备份（备份失败即中止，保回滚点）"
    node scripts/backup.ts
    # 紧跟成功备份：取刚落地的最新快照绝对路径写入标记（无 pipefail，退出码=head=0；必有 ≥1 份）。
    ls -t "$BK_DIR"/backup-*.db | head -1 > "$MARKER"
  fi
fi

echo "[entrypoint] 运行迁移"
node scripts/migrate.ts
# set -e 保证走到这里 = 迁移成功，本次升级闭环，清标记（下轮再有待迁移就重新备份、写新快照路径）。
rm -f "$MARKER"

echo "[entrypoint] 启动服务"
exec node server.js
