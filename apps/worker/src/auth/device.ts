// ---------------------------------------------------------------------------
// /auth/device-grant —— deepc-bridge 设备授权流（Device Grant）
//
// 背景：插件端跑在 http://127.0.0.1:3080（本地 dsh 前端），拿不到 deepc 主站
// 的 ds_session cookie（domain 绑定 deepc.cn）。因此需要独立设备凭证 device_token：
//
//   插件端 ①点登录 → 本地生成 state(uuid) → 打开 /device-login?state=xxx
//           （授权确认页，未登录先走 GitHub OAuth，已登录展示「确认授权」）
//   主站   ②用户点确认 → POST /auth/device-grant { state }（cookie 登录态）
//           → Worker 签发 device_token（D1 存哈希）+ KV deviceGrant:{state} 暂存
//   插件端 ③轮询 POST /auth/device-grant/poll { state } → 一次性换取 device_token
//           → 本地持久化 → 后续 node 端点带 Authorization: Bearer device_token
//
// 安全模型：
//   · device_token 随机 256-bit，D1 只存 SHA-256 哈希（不落明文）。
//   · state 由插件端生成的随机收件箱键，一次性消费 + 短 TTL，防重放/劫持。
//   · 签发需登录态（cookie）；poll 无需登录态（state 即收件箱钥匙）。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { deviceGrantTtl, deviceTokenTtl, kvKeys } from "../lib/kv"
import { appendLog, createDeviceToken, resolveSessionUserId } from "../lib/d1"
import { randomTokenHex, sha256Hex } from "../lib/crypto"
import { getClientIp } from "../lib/ratelimit"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

/** state 校验：非空字符串，长度上限防滥用。 */
function parseState(state: unknown): string | null {
  if (typeof state !== "string" || state.length === 0 || state.length > 128) {
    return null
  }
  return state
}

/**
 * POST /auth/device-grant —— 登录态签发 device_token（收件箱暂存）。
 * 主站授权确认页调用（同源 cookie）；插件端不经此端点（它只 poll）。
 */
export async function handleDeviceGrant(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveSessionUserId(request, env)
  if (githubId === null) return json({ ok: false, authed: false }, 401)

  let body: { state?: unknown }
  try {
    body = (await request.json()) as { state?: unknown }
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }
  const state = parseState(body.state)
  if (state === null) return json({ ok: false, error: "bad-state" }, 400)

  // 签发设备令牌：随机 256-bit，D1 存 SHA-256 哈希。
  const token = randomTokenHex(32)
  const tokenHash = await sha256Hex(token)
  const expiresAt = Date.now() + deviceTokenTtl(env) * 1000
  await createDeviceToken(env, { tokenHash, githubId, nodeId: null, expiresAt })
  await appendLog(env, {
    githubId,
    event: "device_grant",
    ip: getClientIp(request),
  })

  // state 收件箱暂存 token（短 TTL，轮询一次性消费）。
  await env.DEEPSEA_KV.put(kvKeys.deviceGrant(state), token, {
    expirationTtl: deviceGrantTtl(env),
  })

  return json({ ok: true })
}

/**
 * POST /auth/device-grant/poll —— 插件端轮询换取 device_token（一次性消费）。
 * 无登录态：state 是收件箱钥匙，拿不到 state 就换不到 token。
 */
export async function handleDeviceGrantPoll(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { state?: unknown }
  try {
    body = (await request.json()) as { state?: unknown }
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }
  const state = parseState(body.state)
  if (state === null) return json({ ok: false, error: "bad-state" }, 400)

  const token = await env.DEEPSEA_KV.get(kvKeys.deviceGrant(state))
  if (token === null) return json({ ok: false, error: "pending" })

  // 一次性消费：读后即删。
  await env.DEEPSEA_KV.delete(kvKeys.deviceGrant(state))
  return json({ ok: true, token })
}
