#!/bin/sh
# 容器入口：升级安全流程「（待迁移才）备份 → 迁移 → 启动」。
# 首次部署无库 → 跳备份直接迁移建库；升级且 schema 落后 → 先备份再迁移。
# 单实例本身即锁，migrate 的 busy_timeout 兜住与 worker 的偶发并发。
set -e

# 新建文件 0600 / 目录 0700：库含 OAuth 令牌快照与 CDK 码，禁止同宿主其他用户读取。
# 放在 set -e 之后、任何建库/备份之前——覆盖 migrate 建的 app.db 及运行时 -wal/-shm。
umask 077

# MOCK 门控（需求 §8：仍 MOCK=true → 生产拒绝启动）：默认拒启，仅 ALLOW_MOCK_PREVIEW=1 显式放行内网预览。
#   口径与 lib/env.ts 的 `(MOCK ?? 'true') !== 'false'` 一致——只有恰为 false 才算非 mock，缺省/任何其他值都当 MOCK。
#   MOCK 下 /api/auth/dev-login 免鉴权发会话、trustForwardedHeaders 默认 true、SESSION_SECRET 允许空——
#   照默认 cp .env.example .env 直接上公网 = 免鉴权入口 + 伪造头信任，故未显式声明预览就拒启。
# 为何闸门在入口层而非 env.ts 层：next build 阶段 NODE_ENV=production、.env 被 .dockerignore 拦、MOCK 走默认 true——
#   若在 env.ts 层硬拒，镜像构建自身就会炸（构建期无从设 MOCK=false）；运行时入口层才是正确闸门。
#   「生产」无法程序自证，「未显式声明预览的部署一律按生产对待」即该需求的可实现形态。
if [ "${MOCK:-}" != "false" ]; then
  if [ "${ALLOW_MOCK_PREVIEW:-}" = "1" ]; then
    echo "⚠️ [entrypoint] MOCK 预览模式（ALLOW_MOCK_PREVIEW=1）：/api/auth/dev-login 免鉴权发会话、默认信任 x-forwarded-* 头——仅限本机/内网预览"
  else
    echo "🛑 [entrypoint] MOCK≠false 且未声明预览，按生产拒绝启动（需求 §8）。内网预览请设 ALLOW_MOCK_PREVIEW=1；生产请设 MOCK=false 并配齐 SESSION_SECRET/CPA_*"
    exit 1
  fi
fi

DB="${DB_PATH:-/app/data/app.db}"

# 升级标记：落 data/ 持久卷（umask 077 下自然 0600），内容 = 升级前那份快照的绝对路径。
# 为何需要：migrate() 逐迁移独立提交，一次多迁移的升级若后段失败，库会停在「中间版本」；
#   restart:unless-stopped 每次重启 schema-check 都判「落后」，没有去重就每次都备份，且备的是
#   中间态——BACKUP_KEEP 轮转很快把唯一那份「升级前」快照挤掉，恰在最需要回滚时丢掉回滚点。
# 语义：标记记录升级前快照的绝对路径；跳过备份前先验证该快照与 manifest 仍是完整 pair（fail-closed）。
#   完整 pair 仍在 → 沿用它作
#   回滚点、跳过备份；未完结的升级链哪怕中途换了目标版本（原目标 v12 卡住、又部署 v13 的新镜像），也共享
#   这同一份「原始升级前」快照——直到迁移成功 rm 标记才闭环。
#   为何验证存在而非「存在即跳过」：若 BACKUP_DIR 被改到非持久路径（重建即蒸发）或 pair 被人删，
#   裸「存在即跳过」会没回滚点就跑剩余迁移，违背 fail-closed。只有 payload 与 manifest 都不存在时才按当前
#   状态重备一份；任一成员残留或校验失败都中止启动。旧格式标记（内容是版本号、非路径）
#   在对应路径不存在时走「pair 完全缺失」分支重新备份，兼容无需特判。
MARKER="$(dirname "$DB")/.upgrade-in-progress"
BK_DIR="${BACKUP_DIR:-/app/data/backups}"   # 与 scripts/backup.ts 默认解析一致（cwd=/app 的 data/backups）
LATEST=$(node -e "import('./lib/migrate.ts').then((m) => console.log(m.LATEST_VERSION))")   # 仅供日志

# 配置预检（动库前 fail-fast）：非 mock 缺 SESSION_SECRET(≥32)/CPA_* 时 lib/env.ts 会 throw——
#   在备份/迁移之前就中止，避免「schema 已推进、服务却起不来」的中间态（可恢复但顺序不对）。
#   放在任何动库操作（schema-check/备份/迁移）之前。mock 模式下 env.ts 只告警不抛，预检恒过（含「mock 临时密钥」告警）。
#   env.ts 无 import、纯 process.env 读取，顶层 `export const env` 求值即调 resolveSessionSecret/resolveCpa 完成校验——
#   import 它即完成 fail-fast、无副作用（不开库）。
echo "[entrypoint] 配置预检"
node -e "import('./lib/env.ts').then(() => {}, (e) => { console.error(String(e && e.message || e)); process.exit(1) })"

# 仅在「库已存在且 schema 落后」时才考虑备份（schema-check 退出非 0）：
#   保住迁移前那份唯一回滚点，不被日常重启/崩溃循环反复备份 churn 掉（BACKUP_KEEP 轮转）。
if [ -f "$DB" ] && ! node scripts/schema-check.ts; then
  # SNAP：标记里记的快照绝对路径（无标记则空）。`|| true` 保证 set -e 下 cat 缺失不中止。
  SNAP="$([ -f "$MARKER" ] && cat "$MARKER" || true)"
  SNAP_MANIFEST="${SNAP}.manifest.json"
  if [ -n "$SNAP" ] && { [ -e "$SNAP" ] || [ -L "$SNAP" ] || [ -e "$SNAP_MANIFEST" ] || [ -L "$SNAP_MANIFEST" ]; }; then
    if ! node scripts/backup-manifest.ts verify "$SNAP" "$SNAP_MANIFEST" "$(basename "$SNAP")" >/dev/null; then
      echo "🛑 [entrypoint] 升级标记指向的快照 pair 不完整或已漂移：$SNAP" >&2
      exit 1
    fi
    echo "[entrypoint] 上次升级（快照 pair $SNAP）未完结，本次目标 v$LATEST，沿用原升级前快照，跳过备份"
  else
    # 标记在但 pair 两个成员都缺失：告警后重新备份。部分残留已在上面 fail-closed。
    if [ -n "$SNAP" ]; then
      echo "⚠️ [entrypoint] 标记在但快照 pair 已完全缺失（$SNAP）——重新备份当前状态（可能已是中间版本）"
    fi
    # 顺序铁律：先备份成功、再写标记。反过来会在备份失败后把下次备份也一起跳掉。
    # 备份 fail-closed：不 || 兜底，靠 set -e——失败即中止启动，绝不带着丢失的回滚点去迁移。
    # 备份前记录已有集合 → 备份 → 集合差找出新增那份（不靠 mtime——时钟回拨/放回旧快照会让 ls -t 选错份）
    PRE_LIST=$(ls "$BK_DIR"/backup-*.db 2>/dev/null || true)
    echo "[entrypoint] 检测到待迁移，先备份（备份失败即中止，保回滚点）"
    node scripts/backup.ts
    NEW_SNAP=""
    NEW_COUNT=0
    for f in "$BK_DIR"/backup-*.db; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      if printf '%s\n' "$PRE_LIST" | grep -Fqx -- "$f"; then
        continue
      fi
      if ! node scripts/backup-manifest.ts verify "$f" "${f}.manifest.json" "$(basename "$f")" >/dev/null; then
        echo "🛑 [entrypoint] 备份命令发布了不完整或无效的新 pair：$f" >&2
        exit 1
      fi
      NEW_SNAP="$f"
      NEW_COUNT=$((NEW_COUNT + 1))
    done
    if [ "$NEW_COUNT" -ne 1 ]; then
      echo "🛑 [entrypoint] 备份后必须恰好发布 1 个新的有效 pair，实际：$NEW_COUNT" >&2
      exit 1
    fi
    # 钉住升级前快照：lib/backup.ts 轮转只认 ^backup-.*\.db$，改名 preupgrade.db 即豁免轮转——
    #   防「升级卡住期间手动备份 + 低 BACKUP_KEEP」把唯一升级前回滚点转掉。至多一份，下次升级成对替换。
    PIN="$BK_DIR/preupgrade.db"
    PIN_MANIFEST="${PIN}.manifest.json"
    if [ -e "$PIN" ] || [ -L "$PIN" ] || [ -e "$PIN_MANIFEST" ] || [ -L "$PIN_MANIFEST" ]; then
      if ! node scripts/backup-manifest.ts verify "$PIN" "$PIN_MANIFEST" "preupgrade.db" >/dev/null; then
        echo "🛑 [entrypoint] 旧 preupgrade pair 不完整或已漂移，拒绝覆盖：$PIN" >&2
        exit 1
      fi
      # 删除顺序与发布相反：先撤掉 manifest 提交标志，再删 payload。
      rm -f "$PIN_MANIFEST"
      rm -f "$PIN"
    fi
    # pin helper 在共享发布锁内先 rename payload，再以新名生成 manifest，
    # 最后复核 digest/size；不再存在裸 mv 后的无 manifest 安全缺口。
    node scripts/backup-manifest.ts pin "$NEW_SNAP" "$PIN"
    node scripts/backup-manifest.ts verify "$PIN" "$PIN_MANIFEST" "preupgrade.db" >/dev/null
    MARKER_TMP="${MARKER}.tmp.$$"
    printf '%s\n' "$PIN" > "$MARKER_TMP"
    chmod 600 "$MARKER_TMP"
    mv "$MARKER_TMP" "$MARKER"
  fi
fi

echo "[entrypoint] 运行迁移"
node scripts/migrate.ts
# 迁移后复核（防「假成功」）：schema_version 有表无行的遗留库（曾在 CREATE TABLE 与 INSERT 初始行之间被打断），
#   migrate() 里每个迁移都跑 up() 但 `UPDATE schema_version SET version=?` 影响 0 行——版本永不落库，却仍返回内存值、
#   照打「完成 v$LATEST」。若此时就 rm 标记，服务端 assertSchemaCurrent 见持久化 v0 拒启崩溃 → 重启时标记已没、
#   schema-check 又判落后 → 把中间态重备份、BACKUP_KEEP 轮转挤掉真正的升级前快照 → 无回滚点死循环。
# 故清标记前再跑一次 schema-check：持久化版本确已最新（exit 0）才清标记闭环；否则 set -e 中止启动、
#   标记与快照都保留（可按 §5.2 人工还原）。此处 schema-check 会打「已最新，跳过备份」——「跳过备份」尾巴在
#   复核语境略歪但无害，勿改 schema-check 输出（预检共用）。
echo "[entrypoint] 迁移后复核 schema 版本"
node scripts/schema-check.ts
# 复核通过 = 迁移真正落库、本次升级闭环，清标记（下轮再有待迁移就重新备份、写新快照路径）。
rm -f "$MARKER"

echo "[entrypoint] 启动服务"
exec node server.js
