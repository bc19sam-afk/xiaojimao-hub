# syntax=docker/dockerfile:1
# ============================================================================
# 小鸡毛账号收集系统 · 生产镜像（多阶段：deps → builder → runner）
#
# 部署模型（定死）：单机 · 单实例 · SQLite · 单 worker。详见 docs/deploy.md。
# Node 26 内置 TypeScript：迁移/备份脚本原生跑 .ts，无 ts-node、无额外依赖。
# ============================================================================

# ---- deps：只装依赖，最大化利用层缓存（package* 没变就不重装）----
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder：编译 Next，产出 .next/standalone 瘦运行时 ----
FROM node:26-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build 前先串行迁移建库：next build 会并发起多个 page-data worker，每个都求值 lib/db.ts 的
# 模块级副作用去开库 + 跑迁移链。migrate() 逐迁移独立事务，裸并发下两个 worker 可能同时冲同一条
# 非幂等迁移（如 migration 11 的 `ALTER TABLE redeem_items ADD COLUMN per_user_limit`）→ 报
# duplicate column、clean build 随机挂。先单进程迁到最新，build 时各 worker 一看已最新即全跳，
# 竞态消失（播种段本就有 BEGIN IMMEDIATE 兜并发）。此库随后连同 build 产物一并 rm，绝不进镜像。
RUN node scripts/migrate.ts
RUN npm run build
# 上一步迁移 + build 求值 lib/db.ts 都会在 data/app.db 留下库，且被文件追踪器拷进
# .next/standalone/data。这里删掉：绝不把库烘进镜像（红线）。
# runner 稍后自建空 data 目录，真实库只存在于挂载卷里。
RUN rm -rf .next/standalone/data
# public/ 当前不存在——建空目录让 runner 的 COPY 恒成立；日后加静态资源无需改本文件。
RUN mkdir -p public

# ---- runner：最小运行时镜像，非 root ----
FROM node:26-alpine AS runner
WORKDIR /app

# tzdata：TZ=Asia/Shanghai 生效必需。结算按服务器本地日折算，容器默认 UTC 会把结算日切错。
RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
# HOSTNAME=0.0.0.0 是关键：standalone 的 server.js 默认绑容器内 localhost，
# 不设 0.0.0.0 则宿主端口映射进不来。

# standalone 三件套：server.js + 最小 node_modules（拷到 ./）、静态资源、public。
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# 入口要 `node scripts/migrate.ts|backup.ts`（它们 import ../lib/*.ts）——standalone 不含
# 这些源码，单独拷。这俩子树只用 node: 内置模块，Node 26 原生 TS 直接跑，无需 node_modules。
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# 入口脚本：备份 → 迁移 → 启动
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# data 卷（库+备份）需非 root 可写。node 用户 uid=1000（alpine 官方镜像自带）。
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000

# 存活探针（alpine 无 curl，用 Node 内置 fetch）。健康端点只回 {ok:true}，不泄露任何信息。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
