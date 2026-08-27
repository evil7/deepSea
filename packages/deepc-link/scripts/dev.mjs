// ---------------------------------------------------------------------------
// deepc-link dev —— 本地开发循环：kill 旧 dsh web → 清理旧安装 → 编译打包 →
// file:tgz 真实安装到 web profile → 重启 dsh web。
//
// 与 plugin:pack 的区别：pack 只产出 .pack/*.tgz；dev 额外把它「真实安装」到
// dsh web profile（file: 依赖，非 workspace link），确保本地验证的是发布形态
// 的产物（dist 由 pack 流程构建，而非源码直引）。
//
// 为什么不用 link：
//   · link 直引源码目录，dist 变更即时可见，但验证不到「安装后」的真实形态
//     （files 白名单、dsh.bundle 声明、peer 解析等打包期行为）。
//   · tgz 安装则完整走一遍 pnpm 解析 + 解包 + reconcilePlugins，
//     与 `dsh plugin --profile web add deepc-link@latest` 的用户路径一致。
//
// 流程：
//   1. kill 原 dsh web 进程（默认端口 3080 / 命令行匹配 dsh bin.js + web）
//   2. 清理 profile：移除 pnpm-workspace.yaml 里 deepc-link 的 link override
//      （否则 pnpm overrides 优先级高于一切 specifier，会劫持 file:tgz 安装
//      回本地 link）；删除旧 node_modules/deepc-link 残留
//   3. 本地编译 + 打包（scripts/pack.mjs → .pack/deepc-link-{version}.tgz）
//   4. `dsh plugin --profile web remove deepc-link`（容忍未安装）
//   5. `dsh plugin --profile web add <绝对路径>.tgz` —— 真实安装
//   6. 校验安装版本 = 本地版本
//   7. 后台重启 `dsh web`
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(__dirname, '..')
const repoRoot = resolve(pkgRoot, '..', '..')

const PROFILE = 'web'
const WEB_PORT = 3080 // dsh-web-app bundle patch 默认端口（见 webserver 行 port ?? 3080）
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(DSH_HOME, 'profiles', PROFILE)
const packDir = join(pkgRoot, '.pack')

const step = (msg) => console.log(`\n# ${msg}`)

function run(cmd, args, opts = {}) {
  const env = { ...process.env }
  // 清除 pnpm 注入的 npm_config_manage_package_manager_versions（同 pack.mjs）
  delete env.npm_config_manage_package_manager_versions
  // 注意：不带 shell —— node.exe 等直接 spawn，路径含空格（C:\Program Files\...）也安全
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
    ...opts,
  })
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(' ')} 失败 (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
  return r
}

/** shell 参数引号包裹（含空格/特殊字符时加双引号）。 */
function quote(a) {
  const s = String(a)
  return /\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** 通过 shell 运行 dsh 命令（win32 下 dsh 是 .cmd shim，必须走 shell）。 */
function runDsh(args, { tolerate = false } = {}) {
  const env = { ...process.env }
  delete env.npm_config_manage_package_manager_versions
  if (process.platform === 'win32') {
    const cmdLine = ['dsh', ...args.map(quote)].join(' ')
    const r = spawnSync(cmdLine, [], { cwd: repoRoot, stdio: 'inherit', env, shell: true })
    if (r.status !== 0 && !tolerate) {
      console.error(`✗ dsh ${args.join(' ')} 失败 (exit ${r.status ?? 1})`)
      process.exit(r.status ?? 1)
    }
    return r
  }
  const r = spawnSync('dsh', args, { cwd: repoRoot, stdio: 'inherit', env })
  if (r.status !== 0 && !tolerate) {
    console.error(`✗ dsh ${args.join(' ')} 失败 (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
  return r
}

/** 关闭正在运行的 dsh web 进程（端口 3080 优先，命令行匹配兜底覆盖自定义端口）。 */
function killWebProcess() {
  step('关闭原 dsh web 进程')
  if (process.platform !== 'win32') {
    spawnSync('pkill', ['-f', 'dsh.*web'], { stdio: 'inherit' })
    return
  }
  const ps = `
$killed = @()
# 1) 按默认端口找监听进程
Get-NetTCPConnection -LocalPort ${WEB_PORT} -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { $killed += $_.OwningProcess }
# 2) 按命令行匹配 dsh bin.js + web（覆盖自定义 --port 场景）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'dsh' -and $_.CommandLine -match 'bin\\.js' -and $_.CommandLine -match 'web' } |
  ForEach-Object { $killed += $_.ProcessId }
$killed | Select-Object -Unique | ForEach-Object {
  Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  Write-Output ("  killed pid=" + $_)
}
`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
  })
  if (r.status !== 0) console.warn('  (kill 过程中出现异常，忽略继续)')
}

/** 清理 profile 旧安装：移除 deepc-link 的 link override + 删除旧 node_modules。 */
function cleanProfile() {
  step('清理 profile 旧安装与 workspace override')
  if (!existsSync(profileDir)) {
    console.warn(`  profile 不存在：${profileDir}，跳过清理`)
    return
  }
  // 1) 移除 pnpm-workspace.yaml 中 overrides 段里的 deepc-link 条目。
  //    pnpm overrides 优先级高于 add 的 specifier（包括 file:tgz），
  //    残留会把它劫持回本地 link，必须清掉。
  const wsFile = join(profileDir, 'pnpm-workspace.yaml')
  if (existsSync(wsFile)) {
    const lines = readFileSync(wsFile, 'utf8').split(/\r?\n/)
    const out = []
    let inOverrides = false
    let removed = false
    for (const line of lines) {
      if (/^overrides:\s*$/.test(line)) {
        inOverrides = true
        out.push(line)
        continue
      }
      if (inOverrides) {
        if (/^\S/.test(line)) inOverrides = false // 下一个顶层键
        else if (/deepc-link/.test(line)) {
          removed = true
          continue
        }
      }
      out.push(line)
    }
    if (removed) {
      writeFileSync(wsFile, out.join('\n') + '\n')
      console.log('  ✓ 已移除 pnpm-workspace.yaml 的 deepc-link override')
    }
  }
  // 2) 删除旧安装残留（node_modules/deepc-link），避免 add 时新旧混杂
  const installed = join(profileDir, 'node_modules', 'deepc-link')
  if (existsSync(installed)) {
    rmSync(installed, { recursive: true, force: true })
    console.log('  ✓ 已删除旧安装 node_modules/deepc-link')
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  const version = pkg.version

  killWebProcess()
  cleanProfile()

  // 3) 本地编译 + 打包（pack.mjs 内部先跑 build.mjs，再 npm pack → .pack/*.tgz）
  step(`本地编译并打包 deepc-link@${version}`)
  run(process.execPath, [join(pkgRoot, 'scripts', 'pack.mjs')], { cwd: pkgRoot })

  const tgz = join(packDir, `deepc-link-${version}.tgz`)
  if (!existsSync(tgz)) {
    console.error(`✗ 未找到打包产物：${tgz}`)
    process.exit(1)
  }

  // 4) 移除旧依赖声明（若存在），再以 file:tgz 真实安装
  step('以 file:tgz 真实安装到 web profile')
  runDsh(['plugin', '--profile', PROFILE, 'remove', 'deepc-link'], { tolerate: true })
  runDsh(['plugin', '--profile', PROFILE, 'add', tgz])

  // 5) 校验安装结果
  const installedPkg = join(profileDir, 'node_modules', 'deepc-link', 'package.json')
  if (existsSync(installedPkg)) {
    const installed = JSON.parse(readFileSync(installedPkg, 'utf8'))
    if (installed.version === version) console.log(`  ✓ 已安装 deepc-link@${installed.version}`)
    else console.warn(`  ⚠ 安装版本 ${installed.version} ≠ 本地 ${version}`)
  }

  // 6) 后台重启 dsh web（分离进程，终端可继续使用）
  step('启动 dsh web（后台）')
  const child = spawn('dsh', ['web'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  child.unref()
  console.log(`  ✓ dsh web 已在后台启动（默认 http://127.0.0.1:${WEB_PORT}）`)
}

main()
