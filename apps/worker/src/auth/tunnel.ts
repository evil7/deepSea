// ---------------------------------------------------------------------------
// /auth/tunnel/* —— deepc-link 远端互联节点管理（三模式 · 主站仅纳管 URL）
//
// 架构（见 docs/deepsea-tunnel-bridge-proposal.md）：
//   插件本地 3081 鉴权代理（TOTP 2FA）+ 匿名 Quick Tunnel / 自定义域 →
//   登录主站后上报最新 URL。deepc 主站**只纳管 URL 地址**，不存任何
//   secret（TOTP secret 由用户本地 2FA 应用管理）。
//
// 职责（纯管理面，不进数据面）：
//   · report —— 插件每次上线/断链重连：上报最新 URL（upsert，防膨胀）
//   · list   —— 当前用户节点列表（前端 /links）
//   · delete —— 硬删 D1 行（DELETE；tunnel 是用户本地的，无需 CF API）
//
// 鉴权：cookie（主站）/ device_token Bearer（插件端），resolveActorUserId 统一解析。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  reportTunnel,
  getTunnel,
  listTunnels,
  resolveActorUserId,
  deleteTunnel,
} from "../lib/d1"
import { appendLog } from "../lib/d1"
import { getClientIp } from "../lib/ratelimit"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
} as const

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  })
}

/** nodeId 校验：UUID 形态（插件由 hostname 派生，同主机 = 同 ID）。 */
const NODE_ID_RE =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/
/** 节点名上限。 */
const MAX_NAME_LEN = 128
/** URL 上限。 */
const MAX_URL_LEN = 2048

// ---------------------------------------------------------------------------
// POST /auth/tunnel/report —— 插件每次上线：上报最新 URL（upsert）
// ---------------------------------------------------------------------------

export async function handleTunnelReport(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ ok: false, authed: false }, 401)

  let body: { nodeId?: unknown; nodeName?: unknown; url?: unknown; status?: unknown }
  try {
    body = (await request.json()) as { nodeId?: unknown; nodeName?: unknown; url?: unknown; status?: unknown }
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }
  if (typeof body.nodeId !== "string" || !NODE_ID_RE.test(body.nodeId)) {
    return json({ ok: false, error: "bad-node-id" }, 400)
  }
  if (typeof body.url !== "string" || !body.url.startsWith("https://")) {
    return json({ ok: false, error: "bad-url" }, 400)
  }
  const nodeName =
    typeof body.nodeName === "string" && body.nodeName.trim().length > 0
      ? body.nodeName.trim().slice(0, MAX_NAME_LEN)
      : "unnamed"
  const url = body.url.slice(0, MAX_URL_LEN)
  // 状态：默认 connected（上报即在线）；断链上报 offline 时标记节点离线。
  const status = body.status === "offline" ? "offline" : "connected"

  await reportTunnel(env, {
    nodeId: body.nodeId,
    githubId,
    nodeName,
    url,
    status,
  })
  await appendLog(env, {
    githubId,
    event: "tunnel_report",
    detail: body.nodeId,
    ip: getClientIp(request),
  })

  // DO 广播：上线 node_online / 下线 node_offline（前端 /links 实时更新）。
  await broadcastTunnelEvent(env, githubId, {
    type: status === "offline" ? "node_offline" : "node_online",
    nodeId: body.nodeId,
  })

  return json({ ok: true, url, status })
}

// ---------------------------------------------------------------------------
// GET /auth/tunnel/list —— 前端 /links 节点列表
// ---------------------------------------------------------------------------

export async function handleTunnelList(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ ok: false, authed: false }, 401)
  const rows = await listTunnels(env, githubId)
  return json({
    ok: true,
    nodes: rows.map((r) => ({
      nodeId: r.node_id,
      name: r.node_name,
      status: r.status,
      url: r.url,
      lastSeen: r.modified_at,
      createdAt: r.created_at,
    })),
  })
}

// ---------------------------------------------------------------------------
// POST /auth/tunnel/delete —— 硬删节点行（防膨胀；tunnel 是用户本地的，无需 CF API）
// ---------------------------------------------------------------------------

export async function handleTunnelDelete(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ ok: false, authed: false }, 401)

  let body: { nodeId?: unknown }
  try {
    body = (await request.json()) as { nodeId?: unknown }
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }
  if (typeof body.nodeId !== "string" || !NODE_ID_RE.test(body.nodeId)) {
    return json({ ok: false, error: "bad-node-id" }, 400)
  }

  // 归属校验（行存在即存在，无软删概念）
  const row = await getTunnel(env, body.nodeId, githubId)
  if (!row) return json({ ok: false, error: "not-found" }, 404)

  await deleteTunnel(env, body.nodeId, githubId)
  await appendLog(env, {
    githubId,
    event: "tunnel_delete",
    detail: body.nodeId,
    ip: getClientIp(request),
  })

  // DO 广播 node_deleted（插件收到停止本地 cloudflared）。
  await broadcastTunnelEvent(env, githubId, {
    type: "node_deleted",
    nodeId: body.nodeId,
  })

  return json({ ok: true })
}

// ---------------------------------------------------------------------------
// DO 广播（TunnelHub:{githubId}）
// ---------------------------------------------------------------------------

async function broadcastTunnelEvent(
  env: Env,
  githubId: number,
  evt: { type: string; nodeId: string },
): Promise<void> {
  try {
    const id = env.TUNNEL_HUB.idFromName(`tunnelhub:${githubId}`)
    const stub = env.TUNNEL_HUB.get(id)
    await stub.fetch("http://tunnel-hub/broadcast", {
      method: "POST",
      body: JSON.stringify(evt),
    })
  } catch {
    // DO 未初始化（无订阅者）时忽略。
  }
}
