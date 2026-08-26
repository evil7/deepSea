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
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const packDir = join(root, '.pack')

// npm pack --pack-destination 要求目标目录已存在（不存在会 ENOENT）。
// .pack/ 是 gitignore 的本地产物目录，须先确保创建。
mkdirSync(packDir, { recursive: true })

// 清理 .pack/ 下过时的 tgz：版本号递增后残留的旧产物会在每次 pack 前移除，
// 避免误发布 / 误安装到旧版本。
try {
  for (const entry of readdirSync(packDir)) {
    if (/^deepc-link-.*\.tgz$/.test(entry)) {
      rmSync(join(packDir, entry), { force: true })
    }
  }
} catch {
  /* .pack 尚不存在时忽略 */
}

// 用 node 直跑 npm-cli.js（与 node.exe 同目录捆绑）：
// 避免 spawn npm.cmd（Windows 需 shell:true → Node DEP0190 警告），
// 也避免 pnpm/npm .cmd 在 spawnSync 下的兼容性问题。
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')

function run(cmd, args, opts = {}) {
  // 清除 pnpm 注入的 npm_config_manage_package_manager_versions：
  // pnpm 11 检测到根 package.json 的 packageManager 字段就注入该 env config，
  // npm 不识别这个键（无论值真假）→ 每次打包都打 "Unknown env config" 警告。
  const env = { ...process.env }
  delete env.npm_config_manage_package_manager_versions
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env, ...opts })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// 1) build（用 node 直接跑 build.mjs，绕开 pnpm 的 .cmd spawn 问题）。
run(process.execPath, ['scripts/build.mjs'])

// 2) npm pack：在子包 cwd 运行，--pack-destination 指向 .pack/（不进 dist → 不进 tarball）。
run(process.execPath, [npmCli, 'pack', '--pack-destination', packDir])

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
