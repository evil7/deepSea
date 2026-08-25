// cloudflared 托管实机测试（Node 脚本）
//
// 验证：
//   1. ensureBinary：下载 GitHub Release 二进制（或命中已有文件）
//   2. 下载失败提示（mock URL 404 → 抛 cloudflared-download-failed）
//   3. spawn 子进程（--version）
//
// 运行：node test/cloudflared.test.mjs（从 packages/deepc-link 目录）

import { createCloudflaredManager } from './.cloudflared.bundle.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

// ── 1. ensureBinary：下载或命中缓存 ───────────────────────────────────
console.log('① 二进制就绪（下载或缓存命中）')
const mgr = createCloudflaredManager({
  binDir: join(homedir(), '.deepc-test', 'bin'),
  log: (m) => console.log(`  [cf] ${m}`),
})
let binReady = false
try {
  const r = await mgr.ensureBinary()
  binReady = true
  check('ensureBinary 成功', r.path.length > 0)
  check(`来源：${r.fromCache ? '缓存' : '新下载'}`, true)
} catch (e) {
  check('ensureBinary 成功', false, `失败: ${e.message}`)
}

// ── 2. 子进程运行（--version）─────────────────────────────────────────
if (binReady) {
  console.log('② 子进程 spawn（--version）')
  // 直接构造 manager 用 binPath 跑 --version
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)
  const bin = join(homedir(), '.deepc-test', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  try {
    const { stdout } = await execFileP(bin, ['--version'])
    check(`cloudflared --version 输出: ${stdout.trim().split('\n')[0]}`, stdout.length > 0)
  } catch (e) {
    check('cloudflared 可执行', false, `失败: ${e.message}`)
  }
}

// ── 3. 下载失败处理（mock 404 URL → 明确错误 + 提示）────────────────
console.log('③ 下载失败 → 明确错误提示')
const badMgr = createCloudflaredManager({
  binDir: join(homedir(), '.deepc-test', 'bin-bad'),
  downloadUrl: () => 'http://127.0.0.1:1/nonexistent-cloudflared.exe',
  log: (m) => console.log(`  [cf] ${m}`),
})
try {
  await badMgr.ensureBinary()
  check('404 应抛错', false, '未抛错')
} catch (e) {
  check('下载失败抛错', e.message === 'cloudflared-download-failed', `msg=${e.message}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
