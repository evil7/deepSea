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
// 【/ws/api-link 帧协议】—— 全面承载 link 功能在线同步数据：
//   signal 只是其中一种内部命令消息。DO 只做在线态 + 注册表变更推送，业务数据仍存 D1。
//   客户端 → DO：{ type:"signal", target:nodeId, kind:"offer"|"answer", payload:string }
//   DO → 客户端：
//     { type:"presence",       online:string[] }                    // 在线 nodeId 全集
//     { type:"nodes-snapshot", nodes:NodeView[] }                    // connect 时推全量注册表
//     { type:"nodes-changed",  changed:NodeView[], removed:string[] } // 节点增/删/改名增量
//     { type:"signal", from:nodeId, kind:"offer"|"answer", payload:string }
//     { type:"config-changed" }                                       // 配置变更通知
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  getNode,
  listNodes as d1ListNodes,
  resolveActorUserId,
  resolveDeviceUserIdFromToken,
} from "../lib/d1"

/** nodeId 校验：UUID 形态（与 node.ts 一致）。 */
const NODE_ID_RE =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/

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

/** 节点视图（与主站 NodeView / d1 DeepcNodeRow 对齐）。 */
export interface LinkNodeView {
  nodeId: string
  name: string
  lastSeen: number | null
  online: boolean
  createdAt: number
}

/** 节点注册表快照帧（connect 时推全量）。 */
interface OutboundNodesSnapshotFrame {
  type: "nodes-snapshot"
  nodes: LinkNodeView[]
}

/** 节点注册表增量变更帧（节点增/删/改名/上下线时推。全量，客户端覆盖缓存即可做 diff）。 */
interface OutboundNodesChangedFrame {
  type: "nodes-changed"
  nodes: LinkNodeView[]
}

/** socket attachment：登记时的 nodeId + 当前在线判定（webSocketMessage 里读取发送方）。 */
interface SocketAttachment {
  nodeId: string
  /** socket 是否代表一个设备节点（插件端）；主站 console 节点不参与 online 上线广播。 */
  isDevice: boolean
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

    // 内部查询：返回当前在线 nodeId 集合（worker 端 handleNodeList 曾用，现仅供内部复用）。
    // 由 worker 内部 stub 按 room:{githubId} 分区调用，天然账号隔离，无需额外认证。
    if (url.pathname === "/presence") {
      return new Response(JSON.stringify(this.listOnlineNodeIds()), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      })
    }

    // 内部广播：节点注册表已变（HTTP /auth/node/register|remove 写 D1 后触发）。
    // 仅 worker 内部 stub 可达，用于向在线 socket 推送 nodes-changed 帧。
    if (url.pathname === "/nodes-resync" && request.method === "POST") {
      this.broadcastNodesChanged()
      return new Response("ok")
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

    // 缓存本账号 githubId（供 buildNodeViews 查 D1；同一 DO 分区内账号唯一，可安全缓存）。
    this.githubId = githubId

    // 归属校验：nodeId 必须属于该账号（多端直连不越权的根保证）。
    if (!nodeId || !NODE_ID_RE.test(nodeId)) {
      return new Response("bad-node-id", { status: 400 })
    }
    const node = await getNode(this.env, nodeId, githubId)
    if (!node) return new Response("node-not-found", { status: 404 })

    // 区分「设备节点」（插件端 DSH，如 dsh-xxx）vs 「控制端节点」（主站 console）。
    // isDevice 决定该 socket 是否计入「设备在线」广播：主站 console socket 在线
    // 不代表有「可连接的设备」上线，不应触发 nodes-changed 的设备上线节点。
    const isDevice = !node.name.startsWith("deepsea-console")

    // 建连：WebSocketPair → 登记（Hibernation：tag + attachment 存 nodeId/isDevice）。
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.state.acceptWebSocket(server, [nodeId])
    server.serializeAttachment({ nodeId, isDevice } satisfies SocketAttachment)

    // 上线：先推「节点注册表快照」（全量，connect 即得列表；替代已移除的 /auth/node/list），
    // 再广播 presence（在线 nodeId 全集，同账号所有连接即时可见）。
    await this.sendNodesSnapshot(server)
    if (isDevice) this.broadcastNodesChanged()
    this.broadcastPresence()

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * 内部端点：节点注册表已变（HTTP /auth/node/register|remove 写 D1 后触发），
   * 广播全量节点视图给所有在线 socket。仅 worker 内部 stub 可达。
   */
  async resyncNodes(): Promise<void> {
    this.broadcastNodesChanged()
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return

    let frame: { type?: string; [k: string]: unknown }
    try {
      frame = JSON.parse(message) as typeof frame
    } catch {
      return
    }

    // 客户端主动请求节点注册表快照（主站「刷新」按钮）：仅发给请求方。
    if (frame.type === "nodes-request") {
      const nodes = await this.buildNodeViews()
      ws.send(JSON.stringify({ type: "nodes-snapshot", nodes } satisfies OutboundNodesSnapshotFrame))
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

  /** socket 关闭（Hibernation）：广播 presence + 注册表变更（该 socket 已移出 DO 内存态）。 */
  async webSocketClose(): Promise<void> {
    this.broadcastPresence()
    this.broadcastNodesChanged()
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

  /** 收集当前在线的「设备节点」nodeId（isDevice=true，插件端 DSH；排除主站 console）。 */
  private listOnlineDeviceNodeIds(): string[] {
    const set = new Set<string>()
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null
      if (att?.isDevice && att.nodeId) set.add(att.nodeId)
    }
    return [...set]
  }

  /** 向所有 socket 广播 presence 帧（在线 nodeId 全集）。 */
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

  /**
   * 读取 D1 节点注册表 → 合并在线态 → 组装该账号的节点视图列表。
   * 供快照帧 / 变更帧使用。D1 是权威源，DO 只做在线态叠加。
   */
  private async buildNodeViews(): Promise<LinkNodeView[]> {
    // 需要 githubId：从任一 socket attachment 无法得到，故在 DO 内存缓存本账号 githubId。
    // 若为空（理论不可能，建连时已认证），回退为空列表。
    const githubId = this.githubId
    if (githubId === null) return []
    const rows = await d1ListNodes(this.env, githubId)
    const deviceOnline = new Set(this.listOnlineDeviceNodeIds())
    // online 标记：仅「设备节点」上线才算在线（主站 console 节点永远不算「设备在线」）。
    return rows.map((r) => ({
      nodeId: r.node_id,
      name: r.name,
      lastSeen: r.last_seen,
      online: deviceOnline.has(r.node_id),
      createdAt: r.created_at,
    }))
  }

  /** 向单个 socket 推节点注册表快照（connect 时调用）。 */
  private async sendNodesSnapshot(ws: WebSocket): Promise<void> {
    const nodes = await this.buildNodeViews()
    ws.send(JSON.stringify({ type: "nodes-snapshot", nodes } satisfies OutboundNodesSnapshotFrame))
  }

  /** 向所有 socket 推节点注册表变更（全量节点视图；客户端覆盖缓存即可，无需 diff）。 */
  private broadcastNodesChanged(): void {
    void this.buildNodeViews().then((nodes) => {
      const frame: OutboundNodesChangedFrame = { type: "nodes-changed", nodes }
      const payload = JSON.stringify(frame)
      for (const ws of this.state.getWebSockets()) {
        ws.send(payload)
      }
    })
  }

  /** 当前 DO 实例所属的账号（建连时从认证结果缓存；同一 DO 分区内账号唯一）。 */
  private githubId: number | null = null
}
