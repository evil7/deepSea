// 临时：用 esbuild JS API 编译 poc/e2e-local.ts（define 构建变量）→ poc/e2e-local.mjs
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const esbuildPath = 'c:/Users/evil7/_dev/deepSea/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild'
const { build } = require(esbuildPath)

await build({
  entryPoints: ['poc/e2e-local.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  define: {
    __DEEPC_SITE_BASE__: '"https://deepc.cn"',
    __DEEPC_SIGNAL_BASE__: '"https://deepc.cn"',
  },
  outfile: 'poc/e2e-local.mjs',
  logLevel: 'info',
})
console.log('BUILD_OK')
