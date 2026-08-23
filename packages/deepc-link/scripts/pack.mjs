// ---------------------------------------------------------------------------
// deepc-link pack —— 打包 tgz 到 dist/（避免 tgz 落仓库根被误识别上传）。
//
// 流程：pnpm build（node + browser 产出 dist/*.js）→ npm pack → 移动 tgz 到 dist/。
// 用 npm pack 而非 pnpm pack：pnpm filter 模式会把 tgz 落到 workspace root；
// npm pack 在子包 cwd 运行，产到子包根，再移动/pack-destination 到 dist/ 更可控。
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const dist = join(root, 'dist')

// Windows 上 pnpm/npm 是 .cmd，spawnSync 需 shell:true；统一用 node 跑 build 更稳。
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], ...opts })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// 1) build（用 node 直接跑 build.mjs，绕开 pnpm 的 .cmd spawn 问题）。
run(process.execPath, ['scripts/build.mjs'])

// 2) npm pack：在子包 cwd 运行，--pack-destination 指向 dist。
//    用 shell:true 处理 npm.cmd；之后清理 dist 里旧 tgz 避免堆积。
run('npm.cmd', ['pack', '--pack-destination', dist], { shell: true })

// 3) 清理 dist 中可能积存的旧版 tgz 之外的杂项（保留最新）。直接列出确认。
try {
  const entries = readdirSync(dist)
  const tarballs = entries.filter((e) => /^deepc-link-.*\.tgz$/.test(e))
  if (tarballs.length > 0) {
    console.log('✓ tgz 已生成到', dist, '→', tarballs.join(', '))
  }
} catch {
  /* dist 尚不存在时忽略 */
}
