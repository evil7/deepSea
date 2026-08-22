// ---------------------------------------------------------------------------
// SignalRoom —— deepc-link 信令房（Durable Object，方案 A：WS 推送）
//
// 目标：消灭设备侧「5s 轮询信箱」的浪费，改为被动推送（见
// docs/deepsea-deepc-bridge-signaling.md §11/§12）。
//
// 为什么必须 DO：Workers 无状态多实例（多 colo），插件端 WS 连到 colo A、主站请求
// 路由到 colo B，B 拿不到 A 内存里的 socket。DO 提供 single-point-of-coordination——
// 同一账号的所有连接路由到同一 DO 实例，才能做 `nodeId → socket` 的跨连接推送。
//
// 分区键 = githubId（room:{githubId}）：同账号所有设备/主站连同一 DO，天然隔离账号。
//
// 认证 + 归属校验（安全核心）：WS Upgrade 携带 Authorization（device_token / cookie），
// DO 先 resolveActorUserId → githubId，再 getNode 校验 nodeId 归属；非本账号 nodeId
// 无法登记（与 node 端点同源校验）。
//
// 信令加密：WS 只透传密文。offer/answer 由两端用 deriveNodeSignalKey(targetNodeId)
// 派生的 AES-GCM 密钥加密，DO 只见密文 SDP，不见明文（加密复用插件端 crypto.ts）。
//
// 消息帧（JSON 字符串）：
//   客户端 → DO：{ type:"signal", target:nodeId, kind:"offer"|"answer", payload:string }
//   DO → 客户端：{ type:"signal", from:nodeId,  kind:"offer"|"answer", payload:string }
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  getNode,
  resolveActorUserId,
  resolveDeviceUserIdFromToken,
} from "../lib/d1"

/** nodeId 校验：UUID 形态（与 node.ts 一致）。 */
const NODE_ID_RE =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/

interface InboundSignalFrame {
  type: "signal"
  target?: string
  kind?: "offer" | "answer"
  payload?: string
}

interface OutboundSignalFrame {
  type: "signal"
  from: string
  kind: "offer" | "answer"
  payload: string
}

/** presence 帧（DO → 所有 socket）：当前在线 nodeId 全集（上线/下线即广播）。 */
interface OutboundPresenceFrame {
  type: "presence"
  online: string[]
}

/** socket attachment：登记时的 nodeId（webSocketMessage 里读取发送方）。 */
interface SocketAttachment {
  nodeId: string
}

export class SignalRoom {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // 内部广播：config-changed（worker config put 后触发，仅 worker 内部 stub 可达）。
    if (url.pathname === "/config-changed") {
      let excludeNodeId: string | null = null
      try {
        const body = (await request.json()) as { excludeNodeId?: unknown }
        excludeNodeId =
          typeof body.excludeNodeId === "string" ? body.excludeNodeId : null
      } catch {
        /* ignore */
      }
      const frame = JSON.stringify({ type: "config-changed" })
      for (const ws of this.state.getWebSockets()) {
        const att = ws.deserializeAttachment() as SocketAttachment | null
        if (excludeNodeId !== null && att?.nodeId === excludeNodeId) continue
        ws.send(frame)
      }
      return new Response("ok")
    }

    // 内部查询：返回当前在线 nodeId 集合（worker handleNodeList 用，取代 HTTP 心跳）。
    // 由 worker 内部 stub 按 room:{githubId} 分区调用，天然账号隔离，无需额外认证。
    if (url.pathname === "/presence") {
      return new Response(JSON.stringify(this.listOnlineNodeIds()), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      })
    }

    const nodeId = url.searchParams.get("nodeId")

    // 认证：cookie（主站）/ Bearer device_token（插件端 HTTP fetch）；
    // 兜底：浏览器 WebSocket 无法设 Authorization header，插件端经 query
    // `token` 参数传 device_token（wss:// 加密传输，见 §11.3）。
    let githubId = await resolveActorUserId(request, this.env)
    if (githubId === null) {
      const token = url.searchParams.get("token")
      if (token) {
        githubId = await resolveDeviceUserIdFromToken(token, this.env)
      }
    }
    if (githubId === null) return new Response("unauthorized", { status: 401 })

    // 归属校验：nodeId 必须属于该账号（多端直连不越权的根保证）。
    if (!nodeId || !NODE_ID_RE.test(nodeId)) {
      return new Response("bad-node-id", { status: 400 })
    }
    const node = await getNode(this.env, nodeId, githubId)
    if (!node) return new Response("node-not-found", { status: 404 })

    // 建连：WebSocketPair → 登记（Hibernation：tag + attachment 存 nodeId）。
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.state.acceptWebSocket(server, [nodeId])
    server.serializeAttachment({ nodeId } satisfies SocketAttachment)

    // 上线：广播 presence（新 socket 已入 DO 内存态，同账号所有连接即时可见）。
    this.broadcastPresence()

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return

    let frame: InboundSignalFrame
    try {
      frame = JSON.parse(message) as InboundSignalFrame
    } catch {
      return
    }
    if (
      frame.type !== "signal" ||
      typeof frame.target !== "string" ||
      (frame.kind !== "offer" && frame.kind !== "answer") ||
      typeof frame.payload !== "string" ||
      frame.payload.length === 0
    ) {
      return
    }

    // 发送方 nodeId（登记时 attachment 存入）。
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    const from = attachment?.nodeId ?? "unknown"

    // 转发给目标 nodeId 的所有 socket（同 nodeId 可能多端同连，逐一投递）。
    const outbound: OutboundSignalFrame = {
      type: "signal",
      from,
      kind: frame.kind,
      payload: frame.payload,
    }
    const targets = this.state.getWebSockets(frame.target)
    for (const target of targets) {
      target.send(JSON.stringify(outbound))
    }
  }

  /** socket 关闭（Hibernation）：广播 presence（该 socket 已移出 DO 内存态）。 */
  async webSocketClose(): Promise<void> {
    this.broadcastPresence()
  }

  /** 收集当前在线 nodeId（去重；socket 存活 = online，权威源）。 */
  private listOnlineNodeIds(): string[] {
    const set = new Set<string>()
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null
      if (att?.nodeId) set.add(att.nodeId)
    }
    return [...set]
  }

  /** 向所有 socket 广播 presence 帧。 */
  private broadcastPresence(): void {
    const frame: OutboundPresenceFrame = {
      type: "presence",
      online: this.listOnlineNodeIds(),
    }
    const payload = JSON.stringify(frame)
    for (const ws of this.state.getWebSockets()) {
      ws.send(payload)
    }
  }
}
