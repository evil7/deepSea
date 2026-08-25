// ---------------------------------------------------------------------------
// TunnelHub —— deepc-link 管理面事件广播（Durable Object）
//
// 分区键 = githubId（TunnelHub:{githubId}）：同账号前端 /links + 插件 WS 连同一 DO。
// 仅做**管理面事件广播**（节点状态事件），不进数据面。
// 事件：
//   · node_online  —— 插件上报 URL 后推送；前端 /links 更新状态
//   · node_deleted —— 删节点后推送；插件收到停止本地 cloudflared
//
// 订阅方：
//   · 前端 /links：WS 订阅（/ws/tunnel-events?token= 或 cookie）
//   · 插件：出站 WS 长连接（wss://deepc.cn/ws/tunnel-events）
//
// 在线状态判定已改为**前端直连节点隧道地址做 WS ping/pong 探测**（纯前端，不写 DB），
// 故本 DO 只保留「事件广播」职责，不再做 alarm 探活 / 写 status 字段。
//
// Hibernation：WebSocket Hibernation API（入站消息处理完即休眠，空闲不占 CPU）。
// 广播低频（事件驱动，非轮询）→ 免费额度内。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { resolveActorUserId, resolveDeviceUserIdFromToken } from "../lib/d1"

interface SocketAttachment {
  /** 订阅方类型：前端 /link 或插件。 */
  kind: "web" | "plugin"
}

export class TunnelHub {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  /** 向所有已连接订阅者广播事件帧。 */
  private broadcast(evt: { type: string; nodeId: string }): void {
    const frame = JSON.stringify(evt)
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(frame)
      } catch {
        /* socket 已断，忽略 */
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // 内部广播：worker 端写 D1（report/delete）后触发，推送全量订阅者。
    if (url.pathname === "/broadcast" && request.method === "POST") {
      let evt: { type?: string; nodeId?: string } = {}
      try {
        evt = (await request.json()) as { type?: string; nodeId?: string }
      } catch {
        /* ignore */
      }
      if (evt.type && evt.nodeId) {
        this.broadcast({ type: evt.type, nodeId: evt.nodeId })
      }
      return new Response("ok")
    }

    // WS 订阅（/ws/tunnel-events）：前端 cookie / 插件 token。
    let githubId = await resolveActorUserId(request, this.env)
    if (githubId === null) {
      const token = url.searchParams.get("token")
      if (token) githubId = await resolveDeviceUserIdFromToken(token, this.env)
    }
    if (githubId === null) return new Response("unauthorized", { status: 401 })

    const kind: SocketAttachment["kind"] = url.searchParams.get("kind") === "plugin" ? "plugin" : "web"

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ kind } satisfies SocketAttachment)

    // 建连即推一个 hello（前端可确认订阅成功）。
    server.send(JSON.stringify({ type: "hello", kind }))

    return new Response(null, { status: 101, webSocket: client })
  }
}
