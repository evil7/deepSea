// ---------------------------------------------------------------------------
// deepc-link pack —— 打包 tgz 到 .pack/（独立目录，不进 npm tarball）。
//
// 背景：npm publish 的 tarball 由 package.json `files` 白名单决定（含 dist）。
// 若 tgz 生成在 dist/ 内，会被打进 npm tarball（0.0.2 曾混入 deepc-link-0.0.1.tgz）。
// 故改用独立 .pack/ 目录，彻底隔离发布产物。
//
// 流程：pnpm build（node + browser 产出 dist/*.js）→ npm pack → tgz 到 .pack/。
// 用 npm pack 而非 pnpm pack：pnpm filter 模式会把 tgz 落到 workspace root。
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const packDir = join(root, '.pack')

// Windows 上 pnpm/npm 是 .cmd，spawnSync 需 shell:true；统一用 node 跑 build 更稳。
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], ...opts })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// 1) build（用 node 直接跑 build.mjs，绕开 pnpm 的 .cmd spawn 问题）。
run(process.execPath, ['scripts/build.mjs'])

// 2) npm pack：在子包 cwd 运行，--pack-destination 指向 .pack/（不进 dist → 不进 tarball）。
//    用 shell:true 处理 npm.cmd。
run('npm.cmd', ['pack', '--pack-destination', packDir], { shell: true })

// 3) 列出 .pack/ 产物确认。
try {
  const entries = readdirSync(packDir)
  const tarballs = entries.filter((e) => /^deepc-link-.*\.tgz$/.test(e))
  if (tarballs.length > 0) {
    console.log('✓ tgz 已生成到', packDir, '→', tarballs.join(', '))
  }
} catch {
  /* .pack 尚不存在时忽略 */
}
