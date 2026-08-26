/**
 * deepc-link host 壳 —— 三模式编排 + Device Grant + TOTP 2FA + /deepc/* 控制路由。
 *
 * 三种互联模式（用户自选，见 docs/deepsea-tunnel-bridge-proposal.md）：
 *   1. local   本地域内共享：仅 3081 鉴权代理（TOTP 2FA），局域网访问，无需登录/隧道。
 *   2. tunnel  CF Tunnel 暴露：local + cloudflared（匿名 Quick Tunnel 或自定义域）。
 *   3. managed 主站纳管：tunnel + 登录 deepc 主站上报 URL，断链自动重连上报。
 *
 * TOTP secret 持久化到 ~/.deepc/totp-secret（chmod 600）；device_token 持久化到
 * ~/.deepc/device-token。主站只纳管 URL，不存任何 secret —— 最终安全由用户本地掌控。
 */

import { hostname, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { generateConnectId } from './crypto'
import { DEFAULT_SIGNAL_BASE, DEFAULT_SITE_BASE, fetchDeviceProfile } from './device-auth'
import {
  createTunnelManager,
  detectNamedTunnel,
  localLanIp,
  type LinkMode,
  type TunnelManager,
  type TunnelState,
} from './tunnel'
import { createTunnelEventsClient, type TunnelEventsClient } from './events'
import { generateTotpSecret, otpauthUri } from './totp'

/** 后端控制路由路径段（webServer 前缀注册用）。 */
export const NODE_CTRL_PATH = '/deepc'

/** 开发模式调试后端基址（打开「开发模式」开关时使用）。 */
const DEV_MODE_BASE = 'http://127.0.0.1:5174'

/** 本地持久化目录。 */
const DEEPC_DIR = join(homedir(), '.deepc')

export interface DeepcHostOptions {
  /** worker/信令基址。 */
  signalBase?: string
  /** 主站基址。 */
  siteBase?: string
  /** 日志回调。 */
  log?: (msg: string) => void
  /** dsh 实际监听端口（getter：listen 完成前可能返回 undefined，兜底 3080）。 */
  getDshPort?: () => number
}

export interface DeepcHost {
  /** 开始 Device Grant（managed 模式；返回授权 URL，前端打开）。 */
  login: () => Promise<{ url?: string; ok: boolean; reason?: string }>
  /** 启动恢复：读持久化 token + secret，恢复连接。 */
  restore: () => Promise<void>
  /** 登出：清 token + 断开连接。 */
  logout: () => Promise<void>
  /** 状态快照。 */
  status: () => DeepcHostStatus
  /** 启动当前模式互联层。 */
  connect: () => Promise<{ ok: boolean; url?: string; error?: string }>
  /** 断开互联（停 cloudflared；3081 保留）。 */
  disconnect: () => Promise<void>
  /** 切换互联模式（local/tunnel/managed）。 */
  setMode: (mode: LinkMode) => Promise<void>
  /** 切换本地共享开关（3081 局域网暴露）。 */
  setLocal: (on: boolean) => Promise<void>
  /** 重新生成 TOTP secret（用户解绑重绑 2FA 用）。 */
  rotateTotpSecret: () => Promise<string>
  /** 切换开发模式。 */
  setDevMode: (enabled: boolean) => Promise<void>
  /** 切换主站免密（bypass：report 附 sha512(secret) + 3081 ticket 端点）。 */
  setBypass: (enabled: boolean) => Promise<void>
  /** 处理控制路由请求。 */
  handleControl: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** 销毁。 */
  dispose: () => void
}

export interface DeepcHostStatus {
  /** 互联模式。 */
  mode: LinkMode
  loggedIn: boolean
  deviceName: string
  connected: boolean
  /** tunnel URL（managed/tunnel 模式；local 为 null）。 */
  url: string | null
  /** 本地局域网访问地址（local 模式；localOn 开启时显示）。 */
  localUrl: string | null
  /** 本地共享开关（3081 局域网暴露）。 */
  localOn: boolean
  /** TOTP secret（base32，供 UI 展示二维码 + 手动输入）。 */
  totpSecret: string | null
  /** otpauth:// URI（供扫码绑定）。 */
  otpauthUri: string | null
  /** 开发模式。 */
  devMode: boolean
  /** 主站免密开关（bypass）。 */
  allowBypass: boolean
  /** 互联建立时间戳（前端「时长」显示用；null = 未连接）。 */
  connectedAt: number | null
  /** 隧道映射状态机（off/待下载/下载中/已下载/启动中/已启动/已纳管）。 */
  tunnelState: TunnelState
  profile?: { login: string; avatar_url: string; name: string | null }
  error?: string
}

/** 简单 JSON 响应。 */
function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** 由 hostname 派生确定性 UUID v4（node 端 nodeId，同主机 = 同 ID）。 */
function deriveNodeId(name: string): string {
  const hex = createHash('sha256').update(`deepsea-node-v1::${name}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** 轮询 Device Grant（node 端用，token 不入 localStorage）。 */
async function pollDeviceGrant(signalBase: string, state: string): Promise<string | null> {
  const deadline = Date.now() + 5 * 60 * 1000
  const intervalMs = 2_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${signalBase}/auth/device-grant/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      })
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean; token?: string }
        if (body.ok === true && typeof body.token === 'string') return body.token
      }
    } catch {
      // 忽略瞬时错误，继续轮询
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return null
}

/** 持久化 token / secret（chmod 600，失败不阻断）。 */
async function persistFile(relPath: string, content: string): Promise<void> {
  try {
    await mkdir(DEEPC_DIR, { recursive: true })
    const abs = join(DEEPC_DIR, relPath)
    await writeFile(abs, content, { mode: 0o600 })
    await chmod(abs, 0o600).catch(() => {})
  } catch {
    /* 忽略写盘失败（降级为内存态） */
  }
}

/** 读持久化文件（不存在返回 null）。 */
async function readFileIfExists(relPath: string): Promise<string | null> {
  try {
    return await readFile(join(DEEPC_DIR, relPath), 'utf8')
  } catch {
    return null
  }
}

export function createDeepcHost(opts: DeepcHostOptions = {}): DeepcHost {
  const configuredSignalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE
  const configuredSiteBase = opts.siteBase ?? DEFAULT_SITE_BASE
  const log = opts.log ?? ((m: string) => console.log(`[deepc:host] ${m}`))

  /** 开发模式：开启时基址切到本地 127.0.0.1:5174。 */
  let devMode = false
  /** 开发模式调试日志（仅 devMode 下输出，避免污染生产日志）。 */
  const debugLog = (m: string): void => {
    if (devMode) log(m)
  }
  const resolveSignalBase = (): string => (devMode ? DEV_MODE_BASE : configuredSignalBase)
  const resolveSiteBase = (): string => (devMode ? DEV_MODE_BASE : configuredSiteBase)
  /** dsh 实际监听端口（getter 延迟读取，listen 未完成兜底 3080）。 */
  const resolveDshPort = (): number => opts.getDshPort?.() ?? 3080
  /** 鉴权代理端口 = dsh 端口 + 1。 */
  const resolveProxyPort = (): number => resolveDshPort() + 1
  /** 反代上游 = 本机 dsh 端口。 */
  const resolveUpstream = (): string => `http://127.0.0.1:${resolveDshPort()}`

  const deviceName = hostname() ?? 'dsh-node'
  const nodeId = deriveNodeId(deviceName)

  let mode: LinkMode = 'local'
  let token: string | null = null
  let totpSecret: string | null = null
  let tunnel: TunnelManager | null = null
  let events: TunnelEventsClient | null = null
  let lastError: string | undefined
  let profile: DeepcHostStatus['profile']
  // 本地共享开关（3081 局域网暴露）。默认开；关 → 3081 仅绑 127.0.0.1（隧道仍可用）。
  let localOn = true
  // 主站免密（bypass）。默认关；开 → report 附 sha512(secret) + 3081 注册 ticket 端点。
  let allowBypass = false
  /** 互联建立时间戳（前端「时长」显示用；null = 未连接）。 */
  let connectedAt: number | null = null

  let pollGeneration = 0

  // cloudflared 断链自动重连：指数退避（应对 CF Quick Tunnel 限流 429，避免疯狂重连）。
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** 重置断链重连状态（主动连接/断开/切模式时清掉待办定时器与计数）。 */
  function resetReconnect(): void {
    reconnectAttempt = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  /** 停止互联层（cloudflared + 事件订阅 + 3081 代理），返回断开完成的 Promise。 */
  async function stopConnections(): Promise<void> {
    resetReconnect()
    events?.stop()
    events = null
    const t = tunnel
    tunnel = null
    // 必须 await disconnect：确保 3081 端口真正释放，否则切模式重建 tunnel 时
    // 新 proxy 立即 listen 会与旧 proxy 撞 EADDRINUSE（见 auth-proxy.start 幂等 + 此处顺序）。
    if (t) await t.disconnect()
    connectedAt = null
  }

  /** 建立互联层（tunnel manager 按 mode；managed 模式加 DO 事件订阅）。 */
  function setupConnections(): void {
    if (!totpSecret) return
    tunnel = createTunnelManager({
      signalBase: resolveSignalBase(),
      token,
      nodeId,
      nodeName: deviceName,
      totpSecret,
      mode,
      localOn,
      allowBypass,
      namedTunnel: mode !== 'local' ? detectNamedTunnel() : null,
      proxyPort: resolveProxyPort(),
      upstream: resolveUpstream(),
      onExit: () => {
        // cloudflared 断链 → 先上报离线（主站实时标记），再退避重连（成功后 report 恢复在线）。
        // 指数退避：1s → 2s → 4s → … 上限 30s，避免 CF 限流(429)后疯狂重连。
        if (mode !== 'local' && tunnel) {
          void tunnel.reportOffline()
          const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt)
          reconnectAttempt += 1
          log(`cloudflared 断链 → 自动重连（${delay}ms 后，第 ${reconnectAttempt} 次）`)
          if (reconnectTimer) clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            void tunnel?.connect().catch((e) =>
              log(`自动重连失败：${e instanceof Error ? e.message : String(e)}`),
            )
          }, delay)
        }
      },
      log,
    })
    // managed 模式：订阅 DO 事件（node_deleted → 停止本地）。
    if (mode === 'managed' && token) {
      events = createTunnelEventsClient({
        signalBase: resolveSignalBase(),
        token,
        nodeId,
        onEvent: (evt) => {
          if (evt.type === 'node_deleted') {
            log('收到 node_deleted → 停止本地 cloudflared')
            void tunnel?.disconnect().catch(() => {})
          }
        },
        onStatus: (c) => log(`事件订阅 ${c ? '连接' : '断开'}`),
        log,
      })
      events.connect()
    }
  }

  /** 持久化运行时状态（mode/localOn/devMode/allowBypass），刷新/重启后恢复。 */
  async function persistState(): Promise<void> {
    try {
      await persistFile('state.json', JSON.stringify({ mode, localOn, devMode, allowBypass }))
    } catch {
      /* 忽略写盘失败（降级为内存态） */
    }
  }

  /** 读取持久化的运行时状态（不存在/损坏则返回空对象，取默认值）。 */
  async function readState(): Promise<{ mode?: LinkMode; localOn?: boolean; devMode?: boolean; allowBypass?: boolean }> {
    const raw = await readFileIfExists('state.json')
    if (!raw) return {}
    try {
      return JSON.parse(raw) as { mode?: LinkMode; localOn?: boolean; devMode?: boolean; allowBypass?: boolean }
    } catch {
      return {}
    }
  }

  /** 载入持久化的运行时状态 + device_token + TOTP secret。 */
  async function loadPersisted(): Promise<void> {
    // 恢复运行时状态（mode/localOn/devMode/allowBypass）
    const st = await readState()
    if (st.mode === 'local' || st.mode === 'tunnel' || st.mode === 'managed') mode = st.mode
    if (typeof st.localOn === 'boolean') localOn = st.localOn
    if (typeof st.devMode === 'boolean') devMode = st.devMode
    if (typeof st.allowBypass === 'boolean') allowBypass = st.allowBypass
    // 恢复 device_token
    if (!token) {
      token = await readFileIfExists('device-token')
    }
    // 恢复 TOTP secret（无则生成并持久化）
    if (!totpSecret) {
      const saved = await readFileIfExists('totp-secret')
      if (saved) totpSecret = saved
      else {
        totpSecret = generateTotpSecret()
        await persistFile('totp-secret', totpSecret)
      }
    }
  }

  /** 启动当前模式的互联层（local 也启动 3081 鉴权代理；tunnel/managed 额外启动 cloudflared）。 */
  async function connect(): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (mode === 'managed' && !token) {
      lastError = 'not-logged-in'
      return { ok: false, error: 'not-logged-in' }
    }
    if (!totpSecret) {
      totpSecret = generateTotpSecret()
      await persistFile('totp-secret', totpSecret)
    }
    if (!tunnel) setupConnections()
    resetReconnect()
    const r = (await tunnel?.connect()) ?? { ok: false, error: 'no-tunnel-manager' }
    if (!r.ok) {
      lastError = r.error
      connectedAt = null
    } else {
      lastError = undefined
      connectedAt = Date.now()
    }
    return r
  }

  /**
   * 启动当前模式互联层；非 local 模式启动失败（cloudflared 下载失败 / 启动失败 / URL 超时）
   * → 自动回退 local（隧道映射开关自动关闭，用户可重试）。
   */
  async function connectOrFallback(): Promise<{ ok: boolean; url?: string; error?: string }> {
    const r = await connect()
    if (!r.ok && mode !== 'local') {
      log(`互联启动失败（${r.error ?? 'unknown'}）→ 已回退本地模式`)
      mode = 'local'
      await persistState()
      await stopConnections()
      setupConnections()
      if (totpSecret) return await connect()
    }
    return r
  }

  return {
    async login() {
      if (token) {
        // 已登录：仅补拉档案；不切模式、不自动开启隧道。
        // 隧道映射开关始终由用户手动启动，登录只决定「开启时是否上报纳管」（managed vs tunnel）。
        if (!profile) {
          const p = await fetchDeviceProfile(token, { signalBase: resolveSignalBase() })
          if (p) profile = p.profile
        }
        return { ok: true }
      }
      // 未登录：发起 Device Grant 授权，仅保存凭证；不切模式、不自动开启隧道。
      const state = generateConnectId()
      const url = `${resolveSiteBase()}/device-login?state=${encodeURIComponent(state)}`
      const gen = ++pollGeneration
      void (async () => {
        const t = await pollDeviceGrant(resolveSignalBase(), state)
        if (!t || gen !== pollGeneration) return
        token = t
        await persistFile('device-token', t)
        log('Device Grant 完成，已获取 device_token')
        const p = await fetchDeviceProfile(t, { signalBase: resolveSignalBase() })
        if (p) profile = p.profile
      })()
      return { ok: false, url, reason: 'auth-required' }
    },
    async restore() {
      await loadPersisted()
      debugLog(
        `恢复状态：mode=${mode}, localOn=${localOn}, devMode=${devMode}, token=${token ? '已登录' : '未登录'}`,
      )
      // 恢复登录档案（token 存在即已登录，拉 profile 供头部展示）
      if (token) {
        const p = await fetchDeviceProfile(token, { signalBase: resolveSignalBase() })
        if (p) profile = p.profile
      }
      // 有 secret 就真正启动互联层（local 模式也启动 3081 鉴权代理；
      // tunnel/managed 启动失败（下载/启动/超时）自动回退 local）。
      if (totpSecret) {
        setupConnections()
        await connectOrFallback()
      }
      lastError = undefined
    },
    async logout() {
      pollGeneration++
      token = null
      profile = undefined
      try {
        const { unlink } = await import('node:fs/promises')
        await unlink(join(DEEPC_DIR, 'device-token')).catch(() => {})
      } catch {
        /* ignore */
      }
      await stopConnections()
      // 登出后：managed → tunnel（保留隧道，停止纳管上报）
      if (mode === 'managed') {
        mode = 'tunnel'
        await persistState()
      }
      setupConnections()
      if (totpSecret) await connectOrFallback()
    },
    status() {
      return {
        mode,
        loggedIn: token !== null,
        deviceName,
        connected: tunnel?.status().connected ?? false,
        connectedAt,
        url: tunnel?.url() ?? null,
        tunnelState: tunnel?.status().tunnelState ?? 'off',
        localUrl: localOn && localLanIp() ? `http://${localLanIp()}:${resolveProxyPort()}` : null,
        localOn,
        totpSecret,
        otpauthUri: totpSecret ? otpauthUri(totpSecret, deviceName) : null,
        devMode,
        allowBypass,
        profile,
        error: lastError,
      }
    },
    connect,
    async disconnect() {
      await tunnel?.disconnect()
      connectedAt = null
    },
    async setMode(next) {
      if (mode === next) return
      await stopConnections()
      mode = next
      // 强关联：开启隧道/纳管 → 本地共享必然开启（隧道映射的地址就是本地共享 3081 反代）。
      if (next !== 'local' && !localOn) {
        localOn = true
        log('隧道映射开启 → 本地共享一并开启')
      }
      await persistState()
      log(`互联模式 → ${next}`)
      if (next === 'managed' && token) {
        const p = await fetchDeviceProfile(token, { signalBase: resolveSignalBase() })
        if (p) profile = p.profile
      }
      setupConnections()
      // 启动失败（下载/启动/超时）→ connectOrFallback 自动回退 local（开关自动关闭）。
      if (totpSecret) await connectOrFallback()
    },
    async setLocal(on: boolean) {
      if (localOn === on) return
      await stopConnections()
      localOn = on
      // 本地共享关闭 → 隧道映射一并关闭（隧道/纳管是「本地共享」之上的增强暴露）。
      if (!on && mode !== 'local') {
        mode = 'local'
        log('本地共享关闭 → 隧道映射一并关闭')
      }
      await persistState()
      log(`本地共享 ${on ? '开启' : '关闭'}（3081 → ${on ? '0.0.0.0' : '127.0.0.1'}）`)
      setupConnections()
      if (totpSecret) await connect()
    },
    async rotateTotpSecret() {
      totpSecret = generateTotpSecret()
      await persistFile('totp-secret', totpSecret)
      log('TOTP secret 已重新生成（需重新绑定 2FA 应用）')
      await stopConnections()
      setupConnections()
      if (totpSecret) await connectOrFallback()
      return totpSecret
    },
    /** 切换开发模式（基址在 production 与本地 127.0.0.1:5174 间切换）。 */
    async setDevMode(enabled: boolean) {
      if (devMode === enabled) return
      devMode = enabled
      await persistState()
      log(`开发模式 ${enabled ? '开启' : '关闭'}（基址 → ${resolveSignalBase()}）`)
      await stopConnections()
      setupConnections()
      if (totpSecret) await connectOrFallback()
    },
    /** 切换主站免密（bypass：report 附 sha512(secret) + 3081 ticket 端点）。 */
    async setBypass(enabled: boolean) {
      if (allowBypass === enabled) return
      allowBypass = enabled
      await persistState()
      log(`主站免密 ${enabled ? '开启' : '关闭'}`)
      // 重建连接：让 tunnel 重新上报（附/不附 secretHash）并刷新 3081 ticket 端点注册。
      await stopConnections()
      setupConnections()
      if (totpSecret) await connectOrFallback()
    },
    async handleControl(req, res) {
      try {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        // 远端来源（经 3081 反代，auth-proxy 按 Host 非 loopback 注入 x-deepc-remote）：
        // 仅允许只读 status（裁剪敏感字段）+ disconnect（远端「断开」按钮）。
        // 其余敏感控制端点（登录/登出/连接/切模式/本地共享/重生成 TOTP/开发模式/免密）
        // 只允许本地面板操作 —— 纵深防御，即便远端前端有遗漏也拒绝。
        const remote = String(req.headers['x-deepc-remote'] ?? '') === '1'
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/status`) {
          const s = this.status()
          // 远端访问：TOTP secret / 本地地址等敏感字段不下发——secret 只在本地浏览器
          // （127.0.0.1:3080 同源）展示动态码与二维码时需要。纵深防御：
          // 即使前端有遗漏，secret 也绝不经隧道下发到远端浏览器内存。
          if (remote) {
            s.totpSecret = null
            s.otpauthUri = null
            s.localUrl = null
            s.localOn = false
          }
          sendJson(res, 200, s)
          return
        }
        // 远端「断开」按钮：允许（断开后隧道失效，页面即不可用，无越权面）。
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/disconnect`) {
          await this.disconnect()
          sendJson(res, 200, { ok: true })
          return
        }
        // 其余敏感控制端点：远端拒绝（只允许本地面板操作）。
        if (remote) {
          sendJson(res, 403, { ok: false, error: 'remote-forbidden' })
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/login`) {
          const r = await this.login()
          sendJson(res, 200, r)
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/logout`) {
          await this.logout()
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/connect`) {
          const r = await this.connect()
          sendJson(res, 200, r)
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/mode`) {
          const raw = await new Promise<string>((resolve) => {
            let d = ''
            req.on('data', (c) => (d += c))
            req.on('end', () => resolve(d))
          })
          let next: LinkMode = 'local'
          try {
            const m = (JSON.parse(raw || '{}') as { mode?: unknown }).mode
            if (m === 'local' || m === 'tunnel' || m === 'managed') next = m
          } catch {
            /* 非法 body → 默认 local */
          }
          await this.setMode(next)
          sendJson(res, 200, { ok: true, mode: next })
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/local`) {
          const raw = await new Promise<string>((resolve) => {
            let d = ''
            req.on('data', (c) => (d += c))
            req.on('end', () => resolve(d))
          })
          let on = false
          try {
            on = (JSON.parse(raw || '{}') as { on?: boolean }).on === true
          } catch {
            /* 非法 body → 默认 false */
          }
          await this.setLocal(on)
          sendJson(res, 200, { ok: true, localOn: on })
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/totp-rotate`) {
          const secret = await this.rotateTotpSecret()
          sendJson(res, 200, { ok: true, totpSecret: secret })
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/devmode`) {
          const raw = await new Promise<string>((resolve) => {
            let d = ''
            req.on('data', (c) => (d += c))
            req.on('end', () => resolve(d))
          })
          let enabled = false
          try {
            enabled = (JSON.parse(raw || '{}') as { enabled?: boolean }).enabled === true
          } catch {
            /* 非法 body → 默认 false */
          }
          await this.setDevMode(enabled)
          sendJson(res, 200, { ok: true, devMode: enabled })
          return
        }
        if (req.method === 'POST' && pathname === `${NODE_CTRL_PATH}/bypass`) {
          const raw = await new Promise<string>((resolve) => {
            let d = ''
            req.on('data', (c) => (d += c))
            req.on('end', () => resolve(d))
          })
          let enabled = false
          try {
            enabled = (JSON.parse(raw || '{}') as { enabled?: boolean }).enabled === true
          } catch {
            /* 非法 body → 默认 false */
          }
          await this.setBypass(enabled)
          sendJson(res, 200, { ok: true, allowBypass: enabled })
          return
        }
        sendJson(res, 404, { ok: false, error: 'not-found' })
      } catch {
        sendJson(res, 500, { ok: false, error: 'internal' })
      }
    },
    dispose() {
      void stopConnections()
    },
  }
}
