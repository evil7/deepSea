/**
 * deepc-link 插件端 WS 信令客户端 —— Worker `/ws/signal`（DO 信号房，方案 A）。
 *
 * 替换轮询：设备常驻 WS 长连接，被动接收「主站要连我」的 offer 推送，回投 answer。
 * 消息帧与 worker DO 信号房严格对齐（JSON）：
 *   客户端 → DO：{ type:"signal", target:nodeId, kind:"offer"|"answer", payload:string }
 *   DO → 客户端：{ type:"signal", from:nodeId,  kind:"offer"|"answer", payload:string }
 *
 * 认证：浏览器 WebSocket 无法设 Authorization header，故经 query `token` 参数传
 * device_token（wss:// 加密；见 docs/deepsea-deepc-bridge-signaling.md §11.3）。
 */

import type { MailboxKind } from './node-signaling'

interface SignalHandler {
  (from: string, kind: MailboxKind, payload: string): void
}

export interface WsSignalClient {
  /** 建立 WS 连接，返回是否成功。 */
  connect: () => Promise<boolean>
  /** 断开连接。 */
  disconnect: () => void
  /** 投递密文信令到目标 nodeId。 */
  send: (target: string, kind: MailboxKind, payload: string) => void
  /** 订阅「收到推送信令」，返回取消函数。 */
  onSignal: (handler: SignalHandler) => () => void
  /** 订阅「收到 config-changed 通知」（配置同步拉增量用），返回取消函数。 */
  onConfigChanged: (handler: () => void) => () => void
  /** 当前是否已连接。 */
  isConnected: () => boolean
}

/**
 * 创建 WS 信令客户端（node 端专属）。signalBase 为 http(s) 基址，内部转 ws(s)。
 * nodeId 经 query 传递；token 经 query 传递（WS 无法设 Authorization）。
 */
export function createWsSignalClient(opts: {
  signalBase: string
  nodeId: string
  /** device_token（node 端注入，必填）。 */
  token: string
}): WsSignalClient {
  const { signalBase, nodeId } = opts
  let ws: WebSocket | null = null
  let manualClose = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0
  const handlers = new Set<SignalHandler>()
  const configHandlers = new Set<() => void>()

  function wsUrl(): string {
    const wsBase = signalBase.replace(/^http/, 'ws')
    return `${wsBase}/ws/signal?nodeId=${encodeURIComponent(nodeId)}&token=${encodeURIComponent(opts.token)}`
  }

  /** 意外断线后指数退避重连（1s→2s→4s…封顶 30s）；主动 disconnect 则不重连。 */
  function scheduleReconnect(): void {
    if (manualClose || reconnectTimer) return
    const delay = Math.min(1000 * 2 ** retryCount, 30_000)
    retryCount++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connectOnce()
    }, delay)
  }

  function connectOnce(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      let socket: WebSocket
      try {
        socket = new WebSocket(wsUrl())
      } catch {
        settle(false)
        scheduleReconnect()
        return
      }
      ws = socket

      socket.addEventListener('open', () => {
        retryCount = 0
        settle(true)
      })
      socket.addEventListener('error', () => {
        // 失败后浏览器必触发 close，统一在 close 里清理 + 重连。
      })
      socket.addEventListener('message', (ev) => {
        let frame: { type?: string; from?: string; kind?: string; payload?: string }
        try {
          frame = JSON.parse(String(ev.data)) as typeof frame
        } catch {
          return
        }
        if (frame.type === 'config-changed') {
          for (const h of configHandlers) h()
          return
        }
        if (
          frame.type === 'signal' &&
          typeof frame.from === 'string' &&
          (frame.kind === 'offer' || frame.kind === 'answer') &&
          typeof frame.payload === 'string'
        ) {
          for (const h of handlers) h(frame.from, frame.kind, frame.payload)
        }
      })
      socket.addEventListener('close', () => {
        if (ws === socket) ws = null
        settle(false)
        scheduleReconnect()
      })
    })
  }

  return {
    connect: () => {
      manualClose = false
      return connectOnce()
    },
    disconnect: () => {
      manualClose = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      ws?.close()
      ws = null
    },
    send: (target, kind, payload) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'signal', target, kind, payload }))
      }
    },
    onSignal: (handler) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    onConfigChanged: (handler) => {
      configHandlers.add(handler)
      return () => {
        configHandlers.delete(handler)
      }
    },
    isConnected: () => ws !== null && ws.readyState === WebSocket.OPEN,
  }
}
