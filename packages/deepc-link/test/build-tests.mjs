// 构建测试所需的 bundle（esbuild 打包 TS 源 → .mjs，供 node 测试脚本 import）。
// 运行：node test/build-tests.mjs（从 packages/deepc-link 目录）
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const esbuildPath =
  'c:/Users/evil7/_dev/deepSea/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild'
const { build } = require(esbuildPath)

const targets = [
  { entry: 'src/totp.ts', out: 'test/.totp.bundle.mjs' },
  { entry: 'src/auth-proxy.ts', out: 'test/.auth-proxy.bundle.mjs' },
  { entry: 'src/cloudflared.ts', out: 'test/.cloudflared.bundle.mjs' },
]

for (const t of targets) {
  await build({
    entryPoints: [t.entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: {
      __DEEPC_SITE_BASE__: '"https://deepc.cn"',
      __DEEPC_SIGNAL_BASE__: '"https://deepc.cn"',
    },
    outfile: t.out,
    logLevel: 'warning',
  })
  console.log(`✓ ${t.out}`)
}
console.log('BUILD_OK')
