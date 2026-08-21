// ---------------------------------------------------------------------------
// 配置同步端点 —— deepc-bridge 账号级配置（key-value，D1 存储 + DO 推送通知）
//
//   · GET /auth/config/list?since={updatedAt}：增量拉取（since 下推 SQL 走索引，
//     无变更读 0 行，见 docs/deepsea-deepc-bridge-config-sync.md §4）。
//   · POST /auth/config/put { key, value }：LWW 写入 + 单调递增时间戳，
//     写后经 DO 信号房广播 config-changed 到同账号其他在线设备（零轮询）。
//
// 鉴权：resolveActorUserId（cookie 主站 / Bearer device_token 插件端），
// 与 node 端点同源。配置走 D1（写便宜），不再经 gist。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  CONFIG_KEY_RE,
  appendLog,
  listConfig,
  putConfig,
  resolveActorUserId,
} from "../lib/d1"
import { getClientIp } from "../lib/ratelimit"

/** 单条配置 value 上限（64KB）。 */
const MAX_VALUE_BYTES = 64 * 1024

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  })
}

/** 经 DO 信号房广播 config-changed（排除发送方 nodeId，避免回环）。 */
async function broadcastConfigChanged(
  env: Env,
  githubId: number,
  excludeNodeId: string | null
): Promise<void> {
  const id = env.SIGNAL_ROOM.idFromName(`room:${githubId}`)
  const stub = env.SIGNAL_ROOM.get(id)
  await stub.fetch("http://signal-room/config-changed", {
    method: "POST",
    body: JSON.stringify({ excludeNodeId }),
  })
}

/** GET /auth/config/list?since={updatedAt} */
export async function handleConfigList(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ ok: false, error: "unauthorized" }, 401)

  const url = new URL(request.url)
  const since = Number(url.searchParams.get("since") ?? "0") || 0

  const rows = await listConfig(env, githubId, since)
  let maxUpdatedAt = since
  const items = rows.map((r) => {
    if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at
    return { key: r.key, value: r.value, updatedAt: r.updated_at }
  })
  return json({ ok: true, items, maxUpdatedAt })
}

/** POST /auth/config/put { key, value } */
export async function handleConfigPut(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveActorUserId(request, env)
  if (githubId === null) return json({ ok: false, error: "unauthorized" }, 401)

  let body: { key?: unknown; value?: unknown }
  try {
    body = (await request.json()) as { key?: unknown; value?: unknown }
  } catch {
    return json({ ok: false, error: "bad-request" }, 400)
  }
  const key = typeof body.key === "string" ? body.key : ""
  const value = typeof body.value === "string" ? body.value : ""

  if (!CONFIG_KEY_RE.test(key)) {
    return json({ ok: false, error: "bad-key" }, 400)
  }
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES
  ) {
    return json({ ok: false, error: "bad-value" }, 400)
  }

  const updatedAt = await putConfig(env, {
    githubId,
    key,
    value,
    nodeId: null,
  })
  await appendLog(env, {
    githubId,
    event: "config_put",
    detail: key,
    ip: getClientIp(request),
  })

  // 写后广播：其他在线设备收到 config-changed → 拉增量（零轮询）。
  await broadcastConfigChanged(env, githubId, null)

  return json({ ok: true, updatedAt })
}
