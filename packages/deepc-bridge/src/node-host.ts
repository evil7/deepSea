/**
 * deepc-bridge 插件后端主机（node 端）—— 连接层 + 逻辑层。前端只做展示。
 *
 * 运行在 dsh host 的 Node 进程内。职责：
 *   · Device Grant 登录：生成 state → 把 /device-login?state=xxx 授权 URL 交给前端打开
 *     → 轮询 /auth/device-grant/poll 换 device_token（node 端自持，不落浏览器 localStorage）
 *   · 设备注册 + 心跳：node-registry（token 经 node 端存取抽象）
 *   · WS 信令：ws-signaling，被动接收主站 offer（token 经 query）
 *   · 后端专用前缀路由 `/deepc`（ctx.webServer.register）：接收前端控制（status / login /
 *     logout / allow / sync / disconnect），前端经 fetch 调用
 *   · deepc.* 能力：installSession 用 wrapLocalApi(new HttpLocalApi('http://127.0.0.1:3080'))
 *     拦截 deepc.os.hostname / deepc.fs.roots / deepc.fs.listDirectories
 *
 * 与 browser 端 host-ui.ts 的协作：host-ui 只渲染 Sheet，登录状态/开关/同步等动作都
 * 经本地 HTTP 转发到本模块执行。
 */

import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { generateConnectId } from './crypto'
import { DEFAULT_SIGNAL_BASE, DEFAULT_SITE_BASE, fetchDeviceProfile } from './device-auth'
import { createNodeRegistry, type NodeRegistry } from './node-registry'
import { startMailboxHost } from './mailbox-host'
import { startConfigSync } from './config-sync'
import { wrapLocalApi } from './deepc-api'
import { HttpLocalApi } from './local-api'

/** node-host 向后端控制路由暴露的路径段。 */
export const NODE_CTRL_PATH = '/deepc'

export interface NodeHostOptions {
  /** worker/信令基址（本地 dev 127.0.0.1:8787）。 */
  signalBase?: string
  /** 主站基址（本地 dev 127.0.0.1:5174）。 */
  siteBase?: string
  /** 本地 dsh host 基址（127.0.0.1:3080）。 */
  hostBase?: string
}

export interface NodeHost {
  /** 开始 Device Grant（返回授权 URL，前端负责打开）；已有 token 则直接 ready。 */
  login: () => Promise<{ url?: string; ok: boolean; reason?: string }>
  /** 启动时恢复：有持久 token 则自动注册就绪（无需用户点击）。 */
  restore: () => Promise<void>
  /** 登出：清除 token + 停止注册/心跳/信令。 */
  logout: () => Promise<void>
  /** 当前状态快照（供前端渲染）。 */
  status: () => NodeHostStatus
  /** 设置「允许互联」。 */
  setAllowInterconnect: (enabled: boolean) => void
  /** 立即同步配置。 */
  syncNow: () => Promise<void>
  /** 主动断开所有已建多端直连会话。 */
  disconnectAll: () => void
  /** 处理一个后端控制路由请求（供 ctx.webServer.register handler 调用）。 */
  handleControl: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** 销毁：停止注册/心跳/信令。 */
  dispose: () => void
}

export interface NodeHostStatus {
  /** 是否已登录（有 token 且注册成功）。 */
  loggedIn: boolean
  /** 设备名（hostname）或空。 */
  deviceName: string
  /** 当前在线连接会话数。 */
  sessions: number
  /** 互联设置：是否允许新 offer。 */
  allowInterconnect: boolean
  /** 最近一次错误（登录/同步失败的简短原因）。 */
  error?: string
  /** 登录用户的展示档案（供前端渲染头像/昵称）。 */
  profile?: { login: string; avatar_url: string; name: string | null }
}

/** 平台无关 token 存取（node 端：内存 + 可扩展落盘）。 */
class NodeTokenStore {
  private token: string | null = null
  set(next: string): void {
    this.token = next
  }
  get(): string | null {
    return this.token
  }
  clear(): void {
    this.token = null
  }
}

/** 简单 JSON 响应。 */
function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** 读请求 body 为 JSON（限制大小）。 */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) {
        resolve(null)
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * 创建 node-host。在 dsh host Node 进程内启动：回环 HTTP 控制端点 + Device Grant 登录 +
 * 设备注册/心跳 + WS 信令 + deepc.* 能力。
 */
export function createNodeHost(opts: NodeHostOptions = {}): NodeHost {
  const signalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE
  const siteBase = opts.siteBase ?? DEFAULT_SITE_BASE
  const hostBase = opts.hostBase ?? 'http://127.0.0.1:3080'

  const tokenStore = new NodeTokenStore()
  let registry: NodeRegistry | null = null
  let mailbox: ReturnType<typeof startMailboxHost> | null = null
  let configSync: ReturnType<typeof startConfigSync> | null = null
  let allowInterconnect = true
  let loggedIn = false
  let lastError: string | undefined
  let sessionCount = 0
  let profile: NodeHostStatus['profile']

  const deviceName = hostname() ?? 'dsh-node'

  /** 登录成功后：注册 + 心跳 + 信令 + deepc.* 能力。 */
  async function ensureReady(): Promise<void> {
    if (loggedIn) return
    const token = tokenStore.get()
    if (!token) return
    // node-registry 需支持 node 端 token + hostname 派生 nodeId（见 node-registry 改造）。
    registry = createNodeRegistry({ signalBase, name: deviceName, token, nodeId: deriveNodeId(deviceName) })
    const outcome = await registry.start()
    if (outcome !== 'ok') {
      lastError = outcome === 'quota-exceeded' ? 'quota-exceeded' : 'register-failed'
      return
    }
    loggedIn = true
    // 拉取用户档案（供前端渲染头像/昵称）。
    const p = await fetchDeviceProfile(token, { signalBase })
    if (p) profile = p.profile
    configSync = startConfigSync({ signalBase, token })
    mailbox = startMailboxHost({
      nodeId: registry.nodeId,
      signalBase,
      hostBase,
      allowInterconnect,
      token,
      // deepc.* 拦截在 node 端：wrapLocalApi 处理 deepc.os/fs，其余转 HttpLocalApi。
      apiFactory: (base) => wrapLocalApi(new HttpLocalApi(base)),
      onConfigChanged: () => void configSync?.sync(),
    })
    mailbox.onSessionChange((count) => {
      sessionCount = count
    })
  }

  /** 后台轮询 Device Grant → 换 token → 注册（login 触发，不等用户确认完）。 */
  async function pollAndRegister(state: string): Promise<void> {
    const token = await pollDeviceGrant(signalBase, state)
    if (!token) {
      lastError = 'login-timeout'
      return
    }
    tokenStore.set(token)
    await ensureReady()
  }

  /** node 端宿主对象（HTTP handler 闭包引用，避免 this 语义混乱）。 */
  const host: NodeHost = {
    async restore() {
      // 启动时静默恢复：有持久 token 才注册，无 token 则保持未登录（等前端触发 login）。
      if (loggedIn) return
      await ensureReady()
    },
    async login() {
      // 已有 token：恢复就绪态（不重新授权）。
      if (tokenStore.get()) {
        await ensureReady()
        return { ok: true }
      }
      // Device Grant：生成 state + 授权 URL（前端打开），后台轮询换 token。
      const state = generateConnectId()
      const url = `${siteBase}/device-login?state=${encodeURIComponent(state)}`
      // 后台立即开始轮询（不等用户）；前端打开 url 后授权，node 端自持 token。
      void pollAndRegister(state)
      return { ok: false, url, reason: 'auth-required' }
    },
    async logout() {
      tokenStore.clear()
      loggedIn = false
      profile = undefined
      registry?.stop()
      registry = null
      mailbox?.stop()
      mailbox = null
      configSync?.stop()
      configSync = null
      sessionCount = 0
    },
    status() {
      return {
        loggedIn,
        deviceName,
        sessions: sessionCount,
        allowInterconnect,
        error: lastError,
        profile,
      }
    },
    setAllowInterconnect(enabled) {
      allowInterconnect = enabled
      mailbox?.setAllowInterconnect(enabled)
    },
    async syncNow() {
      await configSync?.sync()
    },
    disconnectAll() {
      mailbox?.disconnectAll()
    },
    async handleControl(req, res) {
      try {
        // 路由由 webServer prefix handler 调用，这里接收完整 /deepc/xxx 子路径。
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (req.method === 'POST' && pathname === '/deepc/status') {
          sendJson(res, 200, host.status())
          return
        }
        if (req.method === 'POST' && pathname === '/deepc/login') {
          const r = await host.login()
          sendJson(res, 200, r)
          return
        }
        if (req.method === 'POST' && pathname === '/deepc/logout') {
          await host.logout()
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'POST' && pathname === '/deepc/allow') {
          const body = (await readJson(req)) as { enabled?: boolean } | null
          host.setAllowInterconnect(body?.enabled !== false)
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'POST' && pathname === '/deepc/sync') {
          await host.syncNow()
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'POST' && pathname === '/deepc/disconnect') {
          host.disconnectAll()
          sendJson(res, 200, { ok: true })
          return
        }
        sendJson(res, 404, { ok: false, error: 'not-found' })
      } catch {
        sendJson(res, 500, { ok: false, error: 'internal' })
      }
    },
    dispose() {
      registry?.stop()
      mailbox?.stop()
      configSync?.stop()
    },
  }

  return host
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
