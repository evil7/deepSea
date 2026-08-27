/**
 * deepc-link 事件订阅 —— 出站 WS 连接 TunnelHub DO。
 *
 * managed 模式下插件订阅 node_deleted 事件：
 *   · node_deleted → 停止本地 cloudflared（主站删除节点时收敛）
 * 不再有 code_rotated（TOTP secret 由用户本地 2FA 管理，无后台轮换）。
 * WS 断线 → 自动重连（指数退避）。
 */

import { DEFAULT_SIGNAL_BASE } from './device-auth'

export type TunnelEvent =
  | { type: 'node_online'; nodeId: string }
  | { type: 'node_offline'; nodeId: string }
  | { type: 'node_deleted'; nodeId: string }

export interface TunnelEventsOptions {
  /** Worker/信令基址。 */
  signalBase?: string
  /** device_token（鉴权）。 */
  token: string
  /** 本节点 nodeId（只处理与自己相关的）。 */
  nodeId?: string | null
  /** 事件回调。 */
  onEvent: (evt: TunnelEvent) => void
  /** 连接状态回调。 */
  onStatus?: (connected: boolean) => void
  /** 日志回调。 */
  log?: (msg: string) => void
}

export interface TunnelEventsClient {
  /** 连接（幂等）。 */
  connect: () => void
  /** 断开并停止重连。 */
  stop: () => void
  /** 是否已连接。 */
  connected: () => boolean
}

/** 简易 WS 客户端（Node 20+ 原生 WebSocket；不引入依赖）。 */
export function createTunnelEventsClient(opts: TunnelEventsOptions): TunnelEventsClient {
  const signalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE
  const log = opts.log ?? ((m: string) => console.log(`[deepc:events] ${m}`))

  let ws: WebSocket | null = null
  let stopped = false
  let isConnected = false
  let retryDelay = 1_000
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function cleanup(): void {
    if (ws) {
      try {
        ws.close()
      } catch {
        /* noop */
      }
      ws = null
    }
    isConnected = false
  }

  function scheduleRetry(): void {
    if (stopped) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      open()
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 60_000) // 指数退避，上限 60s
  }

  function open(): void {
    if (stopped || ws) return
    try {
      const url = `${signalBase.replace(/^http/, 'ws')}/ws/tunnel-events?token=${encodeURIComponent(opts.token)}`
      const socket = new WebSocket(url)
      ws = socket
      socket.addEventListener('open', () => {
        isConnected = true
        retryDelay = 1_000
        opts.onStatus?.(true)
        log('事件订阅已连接')
      })
      socket.addEventListener('message', (evt) => {
        const data = evt.data
        const textPromise =
          typeof data === 'string'
            ? Promise.resolve(data)
            : data instanceof Blob
              ? data.text()
              : Promise.resolve('')
        void textPromise.then((text: string) => {
          try {
            const msg = JSON.parse(text) as { type?: string; nodeId?: string }
            if (!msg.type) return
            // 只处理与本节点相关的事件
            if (opts.nodeId && msg.nodeId && msg.nodeId !== opts.nodeId) return
            opts.onEvent(msg as TunnelEvent)
          } catch {
            /* 忽略解析失败 */
          }
        })
      })
      socket.addEventListener('close', () => {
        if (ws === socket) {
          isConnected = false
          opts.onStatus?.(false)
          cleanup()
          scheduleRetry()
        }
      })
      socket.addEventListener('error', () => {
        // 由 onclose 统一处理重连
      })
    } catch {
      scheduleRetry()
    }
  }

  return {
    connect() {
      stopped = false
      open()
    },
    stop() {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      cleanup()
      isConnected = false
    },
    connected() {
      return isConnected
    },
  }
}
