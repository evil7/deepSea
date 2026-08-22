// ---------------------------------------------------------------------------
// deepc-link 主站 WS 信令客户端 —— Worker `/ws/signal`（DO 信号房，方案 A）。
//
// 主站（/links）点设备卡片连接时，经 WS 投递 offer + 接收 answer（替换 HTTP 轮询）。
// 同源部署：dev 经 vite /ws 代理到 worker，生产 deepc.cn 同源直连，cookie 自动携带。
// 消息帧与 worker DO 信号房严格对齐（JSON）：
//   客户端 → DO：{ type:"signal", target:nodeId, kind:"offer"|"answer", payload:string }
//   DO → 客户端：{ type:"signal", from:nodeId,  kind:"offer"|"answer", payload:string }
// ---------------------------------------------------------------------------

interface SignalHandler {
  (from: string, kind: "offer" | "answer", payload: string): void
}

interface PresenceHandler {
  (online: string[]): void
}

export interface WsSignalClient {
  /** 建立 WS 连接（登记 nodeId），返回是否成功。 */
  connect: (nodeId: string) => Promise<boolean>
  /** 断开连接。 */
  disconnect: () => void
  /** 投递密文信令到目标 nodeId。 */
  send: (target: string, kind: "offer" | "answer", payload: string) => void
  /** 订阅「收到推送信令」，返回取消函数。 */
  onSignal: (handler: SignalHandler) => () => void
  /** 订阅「presence 广播」（在线 nodeId 全集，node 上下线即推），返回取消函数。 */
  onPresence: (handler: PresenceHandler) => () => void
  /** 当前是否已连接。 */
  isConnected: () => boolean
}

/** 创建主站 WS 信令客户端（单例复用，同源 cookie 认证）。 */
export function createWsSignalClient(): WsSignalClient {
  let ws: WebSocket | null = null
  const handlers = new Set<SignalHandler>()
  const presenceHandlers = new Set<PresenceHandler>()

  return {
    connect: (nodeId) =>
      new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (ok: boolean): void => {
          if (settled) return
          settled = true
          resolve(ok)
        }
        // 相对路径：dev 5174 → vite /ws 代理 → 8787；生产 deepc.cn 同源直连。
        const url = `/ws/signal?nodeId=${encodeURIComponent(nodeId)}`
        const socket = new WebSocket(url)
        ws = socket

        socket.addEventListener("open", () => settle(true))
        socket.addEventListener("error", () => {
          if (ws === socket) ws = null
          settle(false)
        })
        socket.addEventListener("message", (ev) => {
          let frame: {
            type?: string
            from?: string
            kind?: string
            payload?: string
            online?: unknown
          }
          try {
            frame = JSON.parse(String(ev.data)) as typeof frame
          } catch {
            return
          }
          if (frame.type === "presence" && Array.isArray(frame.online)) {
            const online = (frame.online as unknown[]).filter(
              (x): x is string => typeof x === "string"
            )
            for (const h of presenceHandlers) h(online)
            return
          }
          if (
            frame.type === "signal" &&
            typeof frame.from === "string" &&
            (frame.kind === "offer" || frame.kind === "answer") &&
            typeof frame.payload === "string"
          ) {
            for (const h of handlers) h(frame.from, frame.kind, frame.payload)
          }
        })
        socket.addEventListener("close", () => {
          if (ws === socket) ws = null
        })
      }),
    disconnect: () => {
      ws?.close()
      ws = null
    },
    send: (target, kind, payload) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "signal", target, kind, payload }))
      }
    },
    onSignal: (handler) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    onPresence: (handler) => {
      presenceHandlers.add(handler)
      return () => {
        presenceHandlers.delete(handler)
      }
    },
    isConnected: () => ws !== null && ws.readyState === WebSocket.OPEN,
  }
}
