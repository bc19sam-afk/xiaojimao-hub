/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // 瘦镜像：只打包运行时最小依赖到 .next/standalone，配 Dockerfile 多阶段构建。
  output: 'standalone',
  // 把文件追踪根钉死在本项目目录。否则 Next 会向上找 lockfile 推断根——本仓有
  // 上层 lockfile（如 worktree 在主库之下）时会误判成祖先目录，导致 standalone 里
  // server.js 被套进 .claude/worktrees/... 深层路径，Dockerfile 的 COPY 就拷空。
  // 钉到 import.meta.dirname 后 server.js 恒在 .next/standalone/ 顶层（本地与容器一致）。
  outputFileTracingRoot: import.meta.dirname,
}

export default nextConfig
