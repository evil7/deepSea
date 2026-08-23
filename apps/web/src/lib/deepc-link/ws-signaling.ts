// ---------------------------------------------------------------------------
// deepc-link 主站 WS 客户端 —— Worker `/ws/api-link`（DO 信号房，方案 A）。
//
// 主站（/links）点设备卡片连接时，经 WS 投递 offer + 接收 answer（替换 HTTP 轮询）。
// 同时承载「link 功能在线同步数据」：节点注册表快照/变更、presence、config-changed，
// signal 只是其中一种内部命令帧。
//
// 消息帧与 worker DO 信号房严格对齐（JSON）：
//   客户端 → DO：{ type:"signal", target:nodeId, kind:"offer"|"answer", payload:string }
//   DO → 客户端：
//     { type:"presence",       online:string[] }                    // 在线 nodeId 全集
//     { type:"nodes-snapshot", nodes:NodeView[] }                    // connect 时推全量注册表
//     { type:"nodes-changed",  nodes:NodeView[] }                    // 节点增/删/改名/上下线增量（全量）
//     { type:"signal", from:nodeId, kind:"offer"|"answer", payload:string }
//     { type:"config-changed" }                                       // 配置变更通知
// ---------------------------------------------------------------------------

import type { NodeView } from "./nodes"

interface SignalHandler {
  (from: string, kind: "offer" | "answer", payload: string): void
}

interface PresenceHandler {
  (online: string[]): void
}

interface NodesHandler {
  (nodes: NodeView[]): void
}

export interface WsLinkClient {
  /** 建立 WS 连接（登记 nodeId），返回是否成功。 */
  connect: (nodeId: string) => Promise<boolean>
  /** 断开连接。 */
  disconnect: () => void
  /** 投递密文信令到目标 nodeId。 */
  send: (target: string, kind: "offer" | "answer", payload: string) => void
  /** 主动请求一次节点注册表快照（主站「刷新」按钮），服务器回推 nodes-snapshot。 */
  refreshNodes: () => void
  /** 订阅「收到推送信令」，返回取消函数。 */
  onSignal: (handler: SignalHandler) => () => void
  /** 订阅「presence 广播」（在线 nodeId 全集，node 上下线即推），返回取消函数。 */
  onPresence: (handler: PresenceHandler) => () => void
  /** 订阅「节点注册表快照」（connect 时推全量），返回取消函数。 */
  onNodesSnapshot: (handler: NodesHandler) => () => void
  /** 订阅「节点注册表变更」（增/删/改名/上下线，全量覆盖缓存），返回取消函数。 */
  onNodesChanged: (handler: NodesHandler) => () => void
  /** 当前是否已连接。 */
  isConnected: () => boolean
}

/** 创建主站 WS 客户端（单例复用，同源 cookie 认证）。 */
export function createWsLinkClient(): WsLinkClient {
  let ws: WebSocket | null = null
  const handlers = new Set<SignalHandler>()
  const presenceHandlers = new Set<PresenceHandler>()
  const snapshotHandlers = new Set<NodesHandler>()
  const changedHandlers = new Set<NodesHandler>()

  function parseNodeViews(raw: unknown): NodeView[] {
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (x): x is NodeView =>
          !!x &&
          typeof x === "object" &&
          typeof (x as NodeView).nodeId === "string" &&
          typeof (x as NodeView).name === "string"
      )
      .map((x) => ({
        nodeId: (x as NodeView).nodeId,
        name: (x as NodeView).name,
        lastSeen:
          typeof (x as NodeView).lastSeen === "number"
            ? (x as NodeView).lastSeen
            : null,
        online: (x as NodeView).online === true,
        createdAt:
          typeof (x as NodeView).createdAt === "number"
            ? (x as NodeView).createdAt
            : 0,
      }))
  }

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
        const url = `/ws/api-link?nodeId=${encodeURIComponent(nodeId)}`
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
            nodes?: unknown
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
            frame.type === "nodes-snapshot" &&
            Array.isArray(frame.nodes)
          ) {
            const nodes = parseNodeViews(frame.nodes)
            for (const h of snapshotHandlers) h(nodes)
            return
          }
          if (
            frame.type === "nodes-changed" &&
            Array.isArray(frame.nodes)
          ) {
            const nodes = parseNodeViews(frame.nodes)
            for (const h of changedHandlers) h(nodes)
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
    refreshNodes: () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "nodes-request" }))
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
    onNodesSnapshot: (handler) => {
      snapshotHandlers.add(handler)
      return () => {
        snapshotHandlers.delete(handler)
      }
    },
    onNodesChanged: (handler) => {
      changedHandlers.add(handler)
      return () => {
        changedHandlers.delete(handler)
      }
    },
    isConnected: () => ws !== null && ws.readyState === WebSocket.OPEN,
  }
}
