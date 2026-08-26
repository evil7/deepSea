/**
 * patch-util —— 消除 http-proxy (CJS) 触发的 DEP0060 弃用告警。
 *
 * http-proxy/lib/http-proxy/{index,common}.js 在模块加载时捕获
 * `extend = require('util')._extend`（旧引用），之后在 createProxyServer / 每次代理
 * 请求时调用该引用 → 触发 Node DEP0060
 *（"util._extend() is deprecated. Please use Object.assign() instead."）。
 *
 * 由于 http-proxy 经 `--packages=external` 由 Node 以 CJS 原生加载、且 ESM import
 * 会被 hoist（先于本模块体求值），无法在「捕获引用」前替换 util._extend。
 * 确定性方案（与 auth-proxy.ts 配合）：
 *   1) 本模块用 createRequire 拿到与 http-proxy 相同的 `util` CJS 模块对象，
 *      把 `_extend` 替换为 Object.assign（浅拷贝等价实现）；
 *   2) auth-proxy.ts 把 `import httpProxy from 'http-proxy'` 改为**运行时 require**，
 *      使 http-proxy 在「util._extend 已替换」之后才被首次加载，捕获到的即干净版本。
 */
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const util = nodeRequire('util') as {
  _extend?: <T, U>(target: T, source: U) => T & U
}
if (typeof util._extend === 'function') {
  // 用 Object.assign 等价实现替换 util._extend（http-proxy 捕获到的引用即此实现）。
  util._extend = Object.assign
}
