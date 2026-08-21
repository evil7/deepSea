// ---------------------------------------------------------------------------
// deepc-bridge build —— 产出可安装插件（node 端 + browser 端）
//
//   · node 端：esbuild 打包 src/index.ts → dist/index.js（ESM，external node-datachannel）
//   · browser 端：esbuild 打包 src/client/index.ts → 包装成
//     `window.__ModuleLoader__.load({...})` 格式 → dist/deepc-bridge-client.js
//     （dsh-client-modules 发现 dsh.client 声明后，serve 此文件并注入 __DSH_BOOT__）
//
// 运行：node scripts/build.mjs（或 pnpm build）
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const CLIENT_GLOBAL = '__deepcBridgeClient'
const CLIENT_ID = '@deepsea/deepc-bridge'

/**
 * 环境基址（构建时注入 browser bundle）：
 *   · DEEPC_SITE_BASE：主站基址（默认生产 https://deepc.cn）
 *   · DEEPC_SIGNAL_BASE：Worker/信令基址（默认生产 https://deepc.cn）
 * `--local`：本地 dev 一并指向本地（主站 127.0.0.1:5174 + Worker 127.0.0.1:8787）；
 * 也可用环境变量单独覆盖（优先于 --local）。
 */
const isLocal = process.argv.includes('--local')
const SITE_BASE =
  process.env.DEEPC_SITE_BASE ?? (isLocal ? 'http://127.0.0.1:5174' : 'https://deepc.cn')
const SIGNAL_BASE =
  process.env.DEEPC_SIGNAL_BASE ?? (isLocal ? 'http://127.0.0.1:8787' : 'https://deepc.cn')

const DEFINE = {
  __DEEPC_SITE_BASE__: SITE_BASE,
  __DEEPC_SIGNAL_BASE__: SIGNAL_BASE,
}

/** 查找 esbuild 可执行文件（优先 pnpm .pnpm 里的 @esbuild/win32-x64）。 */
function findEsbuild() {
  const pnpmDir = join(root, '..', '..', 'node_modules', '.pnpm')
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith('@esbuild+win32-x64@')) {
        const exe = join(pnpmDir, entry, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
        if (existsSync(exe)) return exe
      }
    }
  }
  return 'esbuild'
}

/** 用 esbuild 打包 node 端（ESM，external node-datachannel 原生模块）。 */
function buildNode(esbuildExe) {
  execFileSync(
    esbuildExe,
    [
      'src/index.ts',
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--target=es2022',
      '--external:node-datachannel',
      '--external:node-datachannel/polyfill',
      '--outfile=dist/index.js',
    ],
    { cwd: root, stdio: 'inherit' }
  )
}

/** 用 esbuild 打包单文件 IIFE（可自动执行）。 */
function bundleIife(esbuildExe, entry, outfile, globalName) {
  const args = [
    entry,
    '--bundle',
    '--format=iife',
    `--global-name=${globalName}`,
    '--target=es2022',
    `--outfile=${outfile}`,
  ]
  for (const [name, value] of Object.entries(DEFINE)) {
    args.push(`--define:${name}=${JSON.stringify(value)}`)
  }
  execFileSync(esbuildExe, args, { cwd: root, stdio: 'inherit' })
  return readFileSync(outfile, 'utf8')
}

/** 用 esbuild 打包 browser 端 → 临时 iife 输出。 */
function bundleClient(esbuildExe) {
  const outfile = join(root, 'dist', 'client.iife.js')
  const code = bundleIife(esbuildExe, 'src/client/index.ts', outfile, CLIENT_GLOBAL)
  return code
}

/** 把 esbuild iife 输出包装成 window.__ModuleLoader__.load 格式。 */
function wrapClient(iifeCode) {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(CLIENT_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${iifeCode
  .split('\n')
  .map((line) => '\t\t' + line)
  .join('\n')}
\t\texports.name = ${CLIENT_GLOBAL}.name;
\t\texports.apply = ${CLIENT_GLOBAL}.apply;
\t\treturn module.exports;
\t}
});
`
}

function main() {
  mkdirSync(join(root, 'dist'), { recursive: true })
  const esbuildExe = findEsbuild()

  console.log('# deepc-bridge build')
  console.log('# 1/2 node 端（esbuild → dist/index.js）')
  buildNode(esbuildExe)

  console.log('# 2/2 browser 端（esbuild → dist/deepc-bridge-client.js）')
  const iife = bundleClient(esbuildExe)
  const wrapped = wrapClient(iife)
  writeFileSync(join(root, 'dist', 'deepc-bridge-client.js'), wrapped)
  rmSync(join(root, 'dist', 'client.iife.js'), { force: true })
  console.log('  ✓ dist/deepc-bridge-client.js')
}

main()
