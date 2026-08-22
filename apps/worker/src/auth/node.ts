// ---------------------------------------------------------------------------
// /auth/node/* —— deepc-link 多端设备注册
//
// 设备注册：登录账号绑定 node（D1 deepc_nodes），支持心跳续期、改名、删除（吊销）。
// 信令（offer/answer）已由 WS+DO 信号房承载（/ws/signal），不再经 HTTP 信箱轮询。
//
// 安全模型：
//   · 所有端点需有效登录会话（cookie → D1 sessions → github_id）。
//   · node 操作以 github_id 过滤 —— 连接方只能操作自己账号下的设备（不越权）。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  appendLog,
  countNodesByGithub,
  getNode,
  listNodes,
  removeNode,
  resolveActorUserId,
  upsertNode,
} from "../lib/d1"
import { getClientIp } from "../lib/ratelimit"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

/** nodeId 校验：UUID 形态（8-4-4-4-12 或去连字符 32 hex）。 */
const NODE_ID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/
/** 名称长度上限（本端名称）。 */
const MAX_NAME_LEN = 128

/** 每账号最多纳管的 dsh 节点数（防单用户资源滥用）。 */
const MAX_NODES_PER_USER = 3

/**
 * 查询 DO 信号房的在线 nodeId 集合（WS socket 存活 = online，0 HTTP 心跳）。
 * 在线判定权威源 = DO 内存态；last_seen 仅作「最后活跃」展示，不再驱动 online。
 */
async function queryOnlineNodeIds(
  env: Env,
  githubId: number
): Promise<Set<string>> {
  try {
    const id = env.SIGNAL_ROOM.idFromName(`room:${githubId}`)
    const stub = env.SIGNAL_ROOM.get(id)
    const res = await stub.fetch(new Request("https://signal-room/presence"))
    if (!res.ok) return new Set()
    const arr = (await res.json()) as string[]
    return new Set(arr)
  } catch {
    return new Set()
  }
}

// ---------------------------------------------------------------------------
// 设备注册 / 列表 / 心跳 / 删除
// ---------------------------------------------------------------------------

interface RegisterBody {
  nodeId?: unknown
  name?: unknown
}

/** POST /auth/node/register —— upsert 设备（nodeId + name）+ 配额校验。 */
export async function handleNodeRegister(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ authed: false })

  let body: RegisterBody
  try {
    body = (await request.json()) as RegisterBody
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }

  if (typeof body.nodeId !== "string" || !NODE_ID_RE.test(body.nodeId)) {
    return json({ ok: false, error: "bad-node-id" }, 400)
  }
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim().slice(0, MAX_NAME_LEN)
      : "unnamed"

  // 配额校验（原子「判断 + 登记」）：老节点续期不受限，新节点超限拒绝。
  const existing = await getNode(env, body.nodeId, githubId)
  if (existing === null) {
    const used = await countNodesByGithub(env, githubId)
    if (used >= MAX_NODES_PER_USER) {
      return json({
        ok: false,
        error: "quota-exceeded",
        quota: { used, limit: MAX_NODES_PER_USER },
      })
    }
  }

  await upsertNode(env, { nodeId: body.nodeId, githubId, name })
  if (existing === null) {
    await appendLog(env, {
      githubId,
      event: "device_register",
      detail: body.nodeId,
      ip: getClientIp(request),
    })
  }
  const used = await countNodesByGithub(env, githubId)
  return json({ ok: true, quota: { used, limit: MAX_NODES_PER_USER } })
}

/** GET /auth/node/list —— 列出同账号设备（含 online 计算）。 */
export async function handleNodeList(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ authed: false })

  const nodes = await listNodes(env, githubId)
  const online = await queryOnlineNodeIds(env, githubId)
  return json({
    authed: true,
    nodes: nodes.map((n) => ({
      nodeId: n.node_id,
      name: n.name,
      lastSeen: n.last_seen,
      online: online.has(n.node_id),
      createdAt: n.created_at,
    })),
  })
}

interface NodeIdBody {
  nodeId?: unknown
}

/** POST /auth/node/remove —— 删除设备（吊销）。 */
export async function handleNodeRemove(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ authed: false })

  let body: NodeIdBody
  try {
    body = (await request.json()) as NodeIdBody
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }
  if (typeof body.nodeId !== "string" || !NODE_ID_RE.test(body.nodeId)) {
    return json({ ok: false, error: "bad-node-id" }, 400)
  }

  const ok = await removeNode(env, body.nodeId, githubId)
  if (!ok) return json({ ok: false, error: "not-found" }, 404)
  await appendLog(env, {
    githubId,
    event: "device_revoke",
    detail: body.nodeId,
    ip: getClientIp(request),
  })
  return json({ ok: true })
}
