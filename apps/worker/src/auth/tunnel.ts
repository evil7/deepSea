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
import { hmacSha256Hex, randomTokenHex } from "../lib/crypto"
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

  let body: { nodeId?: unknown; nodeName?: unknown; url?: unknown; status?: unknown; secretHash?: unknown }
  try {
    body = (await request.json()) as { nodeId?: unknown; nodeName?: unknown; url?: unknown; status?: unknown; secretHash?: unknown }
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
  // sha512(secret) 单向散列（可选，仅免密直连开启时附带）。
  const secretHash =
    typeof body.secretHash === "string" && /^[0-9a-fA-F]{128}$/.test(body.secretHash)
      ? body.secretHash.toLowerCase()
      : undefined

  await reportTunnel(env, {
    nodeId: body.nodeId,
    githubId,
    nodeName,
    url,
    status,
    ...(secretHash ? { secretHash } : {}),
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
// POST /auth/tunnel/access —— 后台免密直连（bypass）：签发一次性 ticket
//
// 安全模型（见 docs/deepsea-tunnel-bridge-proposal.md 与 deepc-link 架构红线）：
//   · 主站存 sha512(TOTP secret)（单向散列，非明文），用其作密钥签 HMAC ticket。
//   · 插件 3081 本地重算 sha512(secret) 验签 —— secret 明文不出本地，主站不存明文。
//   · ticket 一次性（nonce）+ 短 TTL（30s）+ nodeId 绑定，防重放与跨节点伪造。
// ---------------------------------------------------------------------------

export async function handleTunnelAccess(
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

  // 归属校验（getTunnel 已带 githubId 过滤）。
  const row = await getTunnel(env, body.nodeId, githubId)
  if (!row) return json({ ok: false, error: "not-found" }, 404)
  // 免密直连未启用（插件未开启 bypass，无 secret_hash）。
  if (!row.secret_hash) return json({ ok: false, error: "bypass-disabled" }, 403)
  if (!row.url) return json({ ok: false, error: "no-url" }, 404)

  // 签一次性 ticket：HMAC-SHA256(key=sha512(secret), msg=nodeId:ts:nonce)。
  const ts = Date.now()
  const nonce = randomTokenHex(16)
  const sig = await hmacSha256Hex(
    row.secret_hash,
    `deepc-ticket:${row.node_id}:${ts}:${nonce}`,
  )

  await appendLog(env, {
    githubId,
    event: "tunnel_access",
    detail: row.node_id,
    ip: getClientIp(request),
  })

  return json({
    ok: true,
    url: row.url,
    ticket: { nodeId: row.node_id, ts, nonce, sig },
  })
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
