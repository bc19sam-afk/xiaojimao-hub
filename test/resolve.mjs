// 测试期模块解析钩子：把 lib 内「无扩展名的相对导入」（如 db.ts 的 './migrate'）解析到 .ts。
// 应用源码为配合 Next 打包用的是 extensionless 导入，而 Node 直接跑 .ts 时相对导入必须带扩展名。
// 本钩子只在测试进程生效，不改任何应用代码或构建配置。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export function resolve(specifier, context, nextResolve) {
  // Node 直接加载真实 route 模块时，Next 的 package export `next/server`
  // 在 ESM 解析下需要显式扩展名；Next 自身 bundler 不需要这层测试期兼容。
  if (specifier === 'next/server') return nextResolve('next/server.js', context)
  // Next 的 @/ 路径别名在新进程集成测试中也要指向仓库根目录，才能直接加载真实 route 模块。
  if (specifier.startsWith('@/')) {
    const base = new URL(`../${specifier.slice(2)}`, import.meta.url)
    for (const suffix of ['', '.ts', '.tsx', '.js', '.mjs']) {
      const candidate = new URL(base.href + suffix)
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
    }
  }
  // 仅处理无扩展名的相对导入；其余（node: 内置、带扩展名、包名）走默认解析
  if (/^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) {
    try {
      const asTs = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(asTs))) {
        return nextResolve(specifier + '.ts', context)
      }
    } catch {
      // 忽略，落到默认解析
    }
  }
  return nextResolve(specifier, context)
}
