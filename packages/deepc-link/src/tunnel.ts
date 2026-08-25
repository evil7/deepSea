/**
 * deepc-link 互联层 —— 三模式编排（用户自选）+ TOTP 2FA 注入。
 *
 * 三种模式（递进，用户自选）：
 *   1. local   本地域内共享：只启动 3081 鉴权代理（TOTP 2FA），监听 0.0.0.0，
 *              局域网内其他设备经 `http://<本机IP>:3081` 访问，无需登录/隧道/主站。
 *   2. tunnel  CF Tunnel 暴露：local 基础上启动 cloudflared。自动探测——
 *              有自定义域配置（Named Tunnel config.yml）则用自定义域；否则匿名
 *              Quick Tunnel（xxx.trycloudflare.com）。无需登录/主站。
 *   3. managed 主站纳管：tunnel 基础上登录 deepc 主站，把最新 URL 上报纳管；
 *              cloudflared 断链自动重连并重新上报，登录账号即可查到最新地址。
 *
 * 鉴权：TOTP 2FA（RFC 6238）。secret 由 host.ts 持久化到 ~/.deepc 并注入，
 * 用户用 2FA 应用扫码绑定；动态码 30s 轮换，最终安全由用户本地掌控。
 * 主站 Worker 只纳管 URL，不存任何 secret。
 */

import { existsSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { createCloudflaredManager, type CloudflaredManager } from './cloudflared'
import { createAuthProxy, type AuthProxy } from './auth-proxy'
import { DEFAULT_SIGNAL_BASE } from './device-auth'
import { sha512Hex } from './totp'

/** 互联模式。 */
export type LinkMode = 'local' | 'tunnel' | 'managed'

export interface TunnelManagerOptions {
  /** Worker/信令基址（managed 模式上报用）。 */
  signalBase?: string
  /** device_token（managed 模式需要；local/tunnel 可为 null）。 */
  token: string | null
  /** 本节点 nodeId（hostname 派生；上报用）。 */
  nodeId: string
  /** 节点名（展示用；默认取 nodeId）。 */
  nodeName?: string
  /** TOTP secret（注入 3081；用户 2FA 应用绑定）。 */
  totpSecret: string
  /** 互联模式。 */
  mode: LinkMode
  /** 本地共享开关：true → 3081 监听 0.0.0.0（局域网可达）；false → 仅 127.0.0.1（本机/隧道上游）。 */
  localOn: boolean
  /** 是否启用主站免密（bypass）：true → report 附带 sha512(secret) + 3081 注册 ticket 端点。 */
  allowBypass: boolean
  /** 自定义域配置（Named Tunnel config.yml 路径 + 域名；无则匿名 Quick Tunnel）。 */
  namedTunnel?: { configPath: string; domain: string } | null
  /** 鉴权代理监听端口（= dsh 端口 + 1；默认 3081）。 */
  proxyPort?: number
  /** 反代上游（dsh 实际端口；默认 http://127.0.0.1:3080）。 */
  upstream?: string
  /** cloudflared 进程异常退出回调（managed 模式用于自动重连上报）。 */
  onExit?: () => void
  /** 日志回调。 */
  log?: (msg: string) => void
}

export interface TunnelManager {
  /** 启动当前模式的互联层（3081 + 可选 cloudflared + 可选上报）。 */
  connect: () => Promise<{ ok: boolean; url?: string; error?: string }>
  /** 断开：停止 cloudflared（3081 保留，local 模式复用）。 */
  disconnect: () => Promise<void>
  /** 断链时上报离线（managed 模式；主站标记节点离线，前端实时反映）。 */
  reportOffline: () => Promise<void>
  /** 当前 tunnel URL。 */
  url: () => string | null
  /** 在线状态。 */
  status: () => {
    connected: boolean
    url: string | null
    cloudflaredAlive: boolean
    mode: LinkMode
  }
}

/** 等待 Quick Tunnel URL 的超时（cloudflared 输出 URL 约 2~5s）。 */
const URL_TIMEOUT_MS = 30_000

/** 获取本机局域网 IPv4（local 模式展示访问地址用；无则返回 null）。 */
export function localLanIp(): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return null
}

export function createTunnelManager(opts: TunnelManagerOptions): TunnelManager {
  const signalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE
  const log = opts.log ?? ((m: string) => console.log(`[deepc:tunnel] ${m}`))
  const mode = opts.mode
  const proxyPort = opts.proxyPort ?? 3081
  const upstream = opts.upstream ?? 'http://127.0.0.1:3080'
  // 本地共享关闭时鉴权代理仅绑 127.0.0.1（本机/隧道上游）；开启则 0.0.0.0（局域网可达）。
  const proxyHost = opts.localOn ? '0.0.0.0' : '127.0.0.1'

  const proxy: AuthProxy = createAuthProxy({ log, host: proxyHost, port: proxyPort, upstream })
  const cf: CloudflaredManager = createCloudflaredManager({
    log,
    onUrl: (u) => {
      currentUrl = u
    },
    onExit: () => {
      opts.onExit?.()
    },
  })

  let currentUrl: string | null = null
  let connected = false
  let pendingUrl: Promise<string> | null = null

  /** 上报 URL 到主站纳管（managed 模式；仅 URL，不带任何 secret）。 */
  async function reportApi(
    url: string,
    status: 'connected' | 'offline' = 'connected',
  ): Promise<{ ok: boolean; error?: string }> {
    if (!opts.token) return { ok: false, error: 'not-logged-in' }
    try {
      const res = await fetch(`${signalBase}/auth/tunnel/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({
          nodeId: opts.nodeId,
          nodeName: opts.nodeName ?? opts.nodeId,
          url,
          status,
          // 免密直连开启时附带 sha512(secret)（单向散列，非明文）。
          ...(opts.allowBypass ? { secretHash: sha512Hex(opts.totpSecret) } : {}),
        }),
      })
      if (!res.ok) return { ok: false, error: `report-${res.status}` }
      const body = (await res.json()) as { ok?: boolean; error?: string }
      if (body.ok !== true) return { ok: false, error: body.error ?? 'report-failed' }
      return { ok: true }
    } catch {
      return { ok: false, error: 'network-error' }
    }
  }

  /** 等待 Quick Tunnel URL（onUrl 回调 + 轮询兜底，超时报错）。 */
  function waitUrl(): Promise<string> {
    if (!pendingUrl) {
      pendingUrl = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('tunnel-url-timeout')),
          URL_TIMEOUT_MS,
        )
        const iv = setInterval(() => {
          if (currentUrl) {
            clearTimeout(timer)
            clearInterval(iv)
            resolve(currentUrl)
          }
        }, 500)
      })
    }
    return pendingUrl
  }

  /** 决定 cloudflared 启动参数：自定义域优先，匿名 Quick Tunnel 兜底。 */
  function resolveTunnelArgs(): { args: string[]; fixedUrl: string | null } {
    const named = opts.namedTunnel
    if (named?.configPath && existsSync(named.configPath)) {
      log(`使用自定义域命名隧道：${named.domain}（config=${named.configPath}）`)
      return { args: ['tunnel', 'run', '--config', named.configPath], fixedUrl: named.domain }
    }
    log('使用匿名 Quick Tunnel（trycloudflare.com）')
    return {
      args: ['tunnel', '--url', `http://127.0.0.1:${proxyPort}`, '--no-autoupdate'],
      fixedUrl: null,
    }
  }

  return {
    async connect() {
      // 1. 注入 TOTP secret + 启动 3081 鉴权代理
      proxy.setSecret(opts.totpSecret)
      // 免密直连：开启时注入 nodeId（3081 注册 ticket 端点；关闭时 null）。
      proxy.setBypass(opts.allowBypass ? opts.nodeId : null)
      await proxy.start()

      // 2. local 模式：只本地共享，不启动 cloudflared
      if (mode === 'local') {
        connected = true
        currentUrl = null
        log('本地域内共享已就绪（仅 3081 TOTP 鉴权，无隧道）')
        return { ok: true }
      }

      // 3. 确保 cloudflared 二进制
      try {
        await cf.ensureBinary()
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'binary-error' }
      }

      // 4. 启动 cloudflared（自定义域 / 匿名 Quick Tunnel）
      const { args, fixedUrl } = resolveTunnelArgs()
      pendingUrl = null
      // 断链重连：匿名 Quick Tunnel 每次重连 URL 都会变，先清空旧 URL，
      // 否则 waitUrl() 会立即 resolve 上一个已失效地址 → 上报旧地址。
      if (!fixedUrl) currentUrl = null
      try {
        await cf.start(args)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'cloudflared-start-failed',
        }
      }

      // 5. 取 URL（自定义域直接用固定域名；匿名等 stdout 解析）
      let url: string
      if (fixedUrl) {
        url = fixedUrl
        currentUrl = fixedUrl
      } else {
        try {
          url = await waitUrl()
        } catch (err) {
          await cf.stop()
          return {
            ok: false,
            error: err instanceof Error ? err.message : 'tunnel-url-timeout',
          }
        }
      }

      // 6. managed 模式：上报 URL 到主站
      if (mode === 'managed') {
        const r = await reportApi(url)
        if (!r.ok) {
          await cf.stop()
          return { ok: false, error: r.error }
        }
        log(`已上报 URL 到主站纳管：${url}`)
      }

      connected = true
      log(`已连接：${url}`)
      return { ok: true, url }
    },
    async disconnect() {
      await cf.stop()
      // 停止 3081 鉴权代理（释放端口，避免切换模式重建 tunnel 时重复 listen 触发 EADDRINUSE）。
      await proxy.stop()
      connected = false
      currentUrl = null
      pendingUrl = null
    },
    /** 断链时上报离线（managed 模式）：主站标记节点离线，前端实时反映。 */
    async reportOffline() {
      if (mode !== 'managed' || !opts.token) return
      const url = currentUrl
      if (!url) return
      await reportApi(url, 'offline')
    },
    url() {
      return currentUrl
    },
    status() {
      return {
        connected,
        url: currentUrl,
        cloudflaredAlive: cf.alive(),
        mode,
      }
    },
  }
}

/** 检测自定义域（Named Tunnel）配置：~/.deepc/cloudflared/config.yml 存在即启用。 */
export function detectNamedTunnel(configPath?: string): {
  configPath: string
  domain: string
} | null {
  const cfg = configPath ?? join(homedir(), '.deepc', 'cloudflared', 'config.yml')
  if (!existsSync(cfg)) return null
  const domain = process.env.CF_TUNNEL_DOMAIN
  if (!domain) return null
  return { configPath: cfg, domain: `https://${domain}` }
}
