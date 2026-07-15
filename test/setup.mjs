// 经 `node --import ./test/setup.mjs` 预加载：注册解析钩子，供 node --test 各工作进程使用。
import { register } from 'node:module'

register('./resolve.mjs', import.meta.url)
