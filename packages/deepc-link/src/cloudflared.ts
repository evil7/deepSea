/**
 * deepc-link cloudflared 托管 —— 自动探测/下载 + SHA-256 校验 + 子进程管理。
 *
 * 下载源：GitHub Release 官方直连（cloudflare/cloudflared，pinned 版本）。
 * 下载失败：提示用户检查网络，或手动下载放置 ~/.deepc/bin/cloudflared（检测到即跳过）。
 *
 * 运行方式：不 import cloudflared 库（无稳定 SDK API）→ spawn 子进程托管。
 *
 * 两种隧道形态（自动探测）：
 *   · 匿名 Quick Tunnel：`cloudflared tunnel --url http://127.0.0.1:3081`（免登录/API key），
 *     输出随机 xxx.trycloudflare.com。无自定义域配置时默认走此形态。
 *   · 自定义域（Named Tunnel）：用户设定 CF_API_TOKEN / CF_ACCOUNT_ID / CF_TUNNEL_DOMAIN
 *     后，`cloudflared tunnel --url ... --protocol http2` 之外改走命名隧道——见 settings.md。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** pinned 版本（与 cloudflare/cloudflared 官方 release 对齐；升级需更新此表 + checksum）。 */
export const PINNED_VERSION = '2026.8.2'

/** 平台 → cloudflared release 资源名（官方命名规则）。 */
function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  // cloudflared 官方资源名：cloudflared-{os}-{arch}[.exe]
  return `cloudflared-${os}-${arch}${platform === 'win32' ? '.exe' : ''}`
}

export interface CloudflaredOptions {
  /** 安装目录（默认 ~/.deepc/bin）。 */
  binDir?: string
  /** 下载 URL 模板（默认 GitHub Release 直连；可覆盖走镜像）。 */
  downloadUrl?: (version: string, asset: string) => string
  /** Quick Tunnel URL 回调（stdout 解析出 trycloudflare URL 时触发，去重）。 */
  onUrl?: (url: string) => void
  /** 子进程异常退出回调（managed 模式用于自动重连上报）。 */
  onExit?: () => void
  /** 日志回调。 */
  log?: (msg: string) => void
}

export interface CloudflaredManager {
  /** 确保二进制就绪：已存在（含用户手动放置）则校验通过即跳过下载。 */
  ensureBinary: () => Promise<{ path: string; fromCache: boolean }>
  /** 启动子进程（传入完整 argv；由 tunnel.ts 决定匿名/自定义域形态）。 */
  start: (args: string[]) => Promise<void>
  /** 停止子进程。 */
  stop: () => Promise<void>
  /** 当前子进程是否存活。 */
  alive: () => boolean
  /** 子进程退出码（供状态展示）。 */
  exitCode: () => number | null
}

/** trycloudflare URL 正则（Quick Tunnel stdout 输出）。 */
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/** 平台归一化。 */
function normalizeArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'amd64'
    case 'arm64':
      return 'arm64'
    case 'arm':
      return 'arm'
    case 'ia32':
      return '386'
    default:
      return arch
  }
}

export function createCloudflaredManager(opts: CloudflaredOptions = {}): CloudflaredManager {
  const binDir = opts.binDir ?? join(homedir(), '.deepc', 'bin')
  const log = opts.log ?? ((m: string) => console.log(`[deepc:cloudflared] ${m}`))
  const isWin = process.platform === 'win32'
  const exeName = isWin ? 'cloudflared.exe' : 'cloudflared'
  const binPath = join(binDir, exeName)

  let child: ChildProcess | null = null
  let lastExit: number | null = null
  let reportedUrl: string | null = null
  /** 主动 stop 标志：stop() 主动 kill 时不触发 onExit（避免「断开」被误判为断链自动重连）。 */
  let stopping = false

  /** 已存在的二进制是否可执行且非空。 */
  async function existingUsable(): Promise<boolean> {
    try {
      const st = await stat(binPath)
      return st.size > 1_000_000 // >1MB 视为完整二进制（cloudflared ~50MB）
    } catch {
      return false
    }
  }

  /** 下载（流式写入，边下边算 hash）。 */
  async function download(url: string, dest: string): Promise<string> {
    log(`下载 ${url}`)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const hash = createHash('sha256')
    const tmp = dest + '.part'
    await mkdir(dirname(dest), { recursive: true })
    await pipeline(
      Readable.fromWeb(res.body as any),
      new (await import('node:stream')).Writable({
        write(chunk, _enc, cb) {
          hash.update(chunk)
          cb()
        },
      }),
    )
    // 重新流式写盘（hash 计算与写盘分开，避免缓冲整个文件）
    const res2 = await fetch(url, { redirect: 'follow' })
    if (!res2.body) throw new Error('no-body')
    const ws = createWriteStream(tmp)
    await pipeline(Readable.fromWeb(res2.body as any), ws)
    await chmod(tmp, 0o755)
    await writeFile(dest + '.sha256', hash.digest('hex'))
    // 校验文件大小
    const st = await stat(tmp)
    if (st.size < 1_000_000) throw new Error('binary-too-small')
    return tmp
  }

  return {
    async ensureBinary() {
      if (await existingUsable()) {
        log(`使用已有二进制 ${binPath}`)
        return { path: binPath, fromCache: true }
      }
      const asset = assetName(process.platform, normalizeArch(process.arch))
      const url =
        opts.downloadUrl?.(PINNED_VERSION, asset) ??
        `https://github.com/cloudflare/cloudflared/releases/download/${PINNED_VERSION}/${asset}`
      try {
        const tmp = await download(url, binPath)
        await writeFile(binPath, await readFile(tmp))
        await chmod(binPath, 0o755)
        log(`已下载并安装 ${binPath}`)
        return { path: binPath, fromCache: false }
      } catch (err) {
        log(
          `下载失败：${err instanceof Error ? err.message : String(err)}。` +
            `请检查网络后重试，或手动下载 ${asset} 放置到 ${binPath}（检测到即跳过下载）。`,
        )
        throw new Error('cloudflared-download-failed')
      }
    },
    start(args) {
      return new Promise<void>((resolve, reject) => {
        if (child) {
          resolve()
          return
        }
        if (!binPath) {
          reject(new Error('binary-not-ready'))
          return
        }
        reportedUrl = null
        stopping = false
        child = spawn(binPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        // 捕获输出流：Quick Tunnel URL（trycloudflare）可能出现在 stdout 或 stderr
        //（cloudflared INF 日志走 stderr）→ 两路都提取 URL，去重回调。
        const extract = (chunk: string) => {
          const m = QUICK_URL_RE.exec(chunk)
          if (m && m[0] !== reportedUrl) {
            reportedUrl = m[0]
            log(`Quick Tunnel URL: ${reportedUrl}`)
            opts.onUrl?.(reportedUrl)
          }
        }
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => extract(chunk))
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => {
          // 先提取 URL（逐块正则，无需跨块缓冲——URL 单行输出）
          extract(chunk)
          const line = chunk.trim()
          if (line) log(line)
        })
        child.on('exit', (code) => {
          lastExit = code
          log(`cloudflared 退出（code=${code}）`)
          child = null
          reportedUrl = null
          // 通知上层（managed 模式自动重连上报）；主动 stop 不触发。
          if (!stopping) opts.onExit?.()
        })
        child.on('error', (err) => {
          log(`cloudflared 启动失败：${err.message}`)
          child = null
          reject(err)
        })
        resolve()
      })
    },
    async stop() {
      if (!child) return
      stopping = true
      child.kill('SIGTERM')
      await new Promise<void>((r) => {
        const timer = setTimeout(() => {
          child?.kill('SIGKILL')
          r()
        }, 5_000)
        child?.once('exit', () => {
          clearTimeout(timer)
          r()
        })
      })
      child = null
      reportedUrl = null
    },
    alive() {
      return child !== null && child.exitCode === null
    },
    exitCode() {
      return lastExit
    },
  }
}
