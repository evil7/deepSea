// ---------------------------------------------------------------------------
// /auth/signal/* —— deepc 声纳互联的 WebRTC 信令交换（密文透传）
//
// 定位：信令是「连接授权的凭证交换」，与 OAuth 的 state（短 TTL 存 KV）同构，
// 因此归入 auth 范畴（不新增 /api 代理、不触碰「Worker 只做 auth」红线）。
//
// 安全模型：
//   · 不强制 OAuth 登录（node 端跑在 dsh host，无 deepSea 登录态）——授权凭证
//     就是配对码派生的 roomId（不知道配对码就不知道 roomId，无法读写 room 信令）。
//   · KV 只存密文（SDP 由两端用 HKDF(配对码) 派生的 AES-GCM 密钥加密），
//     Worker 永不见 SDP 明文。
//   · get 一次性消费（读后即删）+ 短 TTL，防重放/滥用。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { kvKeys, signalTtl } from "../lib/kv"
import {
  checkErrorLimit,
  getClientIp,
  recordError,
} from "../lib/ratelimit"

/** roomId 校验：64 位 hex（HKDF 派生，32 字节 → 64 hex） */
const ROOM_ID_RE = /^[0-9a-f]{64}$/
/** payload 上限：SDP 密文（含 ICE 候选）通常 < 16KB，放宽到 64KB 兜底 */
const MAX_PAYLOAD_BYTES = 64 * 1024

/**
 * 信令 CORS：dsh 前端（任意本地端口）与 /sonar 页面跨源访问信令。
 * 信令本身是「配对码即授权」的密文透传（roomId = HKDF(配对码)，SDP 已 AES-GCM 加密），
 * 无 cookie/session，故允许任意 Origin 安全（不比允许匿名 roomId 访问多泄露）。
 */
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

/** 处理 CORS preflight（OPTIONS）。 */
export function handleSignalOptions(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } })
}

interface SignalPutBody {
  roomId?: unknown
  kind?: unknown
  payload?: unknown
}

interface SignalGetBody {
  roomId?: unknown
  kind?: unknown
}

/** 解析 + 校验 roomId / kind 公共部分，非法返回 null。 */
function parseCommon(body: SignalPutBody | SignalGetBody): {
  roomId: string
  kind: "offer" | "answer"
} | null {
  if (typeof body.roomId !== "string" || !ROOM_ID_RE.test(body.roomId)) {
    return null
  }
  if (body.kind !== "offer" && body.kind !== "answer") return null
  return { roomId: body.roomId, kind: body.kind }
}

/** POST /auth/signal/put —— 写入密文信令（短 TTL） */
export async function handleSignalPut(
  request: Request,
  env: Env
): Promise<Response> {
  let body: SignalPutBody
  try {
    body = (await request.json()) as SignalPutBody
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }

  const common = parseCommon(body)
  if (!common) return json({ ok: false, error: "bad-request" }, 400)
  if (
    typeof body.payload !== "string" ||
    body.payload.length === 0 ||
    body.payload.length > MAX_PAYLOAD_BYTES
  ) {
    return json({ ok: false, error: "bad-payload" }, 400)
  }

  await env.DEEPSEA_KV.put(
    kvKeys.signal(common.roomId, common.kind),
    body.payload,
    { expirationTtl: signalTtl(env) }
  )
  return json({ ok: true })
}

/** POST /auth/signal/get —— 读取密文信令（一次性消费：读后即删 + 错误限流） */
export async function handleSignalGet(
  request: Request,
  env: Env
): Promise<Response> {
  let body: SignalGetBody
  try {
    body = (await request.json()) as SignalGetBody
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }

  const common = parseCommon(body)
  if (!common) return json({ ok: false, error: "bad-request" }, 400)

  // 错误限流：封禁态直接拒绝，附剩余/重试信息供前端提示。
  const ip = getClientIp(request)
  const errLimit = await checkErrorLimit(env, ip)
  if (!errLimit.ok) {
    return json(
      {
        ok: false,
        error: "rate-limited",
        remainingAttempts: errLimit.remaining,
        retryAfter: errLimit.retryAfter,
      },
      429
    )
  }

  const key = kvKeys.signal(common.roomId, common.kind)
  const payload = await env.DEEPSEA_KV.get(key)
  if (payload === null) {
    // 错误限流只针对 offer 的 not-found：client 用错误口令派生的 roomId
    // poll offer 会 404，这才是「口令错误」。而 host 端 poll answer 的 404
    // 是「client 尚未连上」的正常等待，绝不能记错误（否则每次正常配对都会
    // 累积 1 次错误，5 次正常配对后误封禁）。
    if (common.kind === "offer") {
      const remaining = await recordError(env, ip, common.roomId)
      return json(
        {
          ok: false,
          error: "not-found",
          remainingAttempts: remaining,
        },
        404
      )
    }
    return json({ ok: false, error: "not-found" }, 404)
  }

  // 一次性消费：读后即删（原子性由 KV 单键操作保证）
  await env.DEEPSEA_KV.delete(key)
  return json({ ok: true, payload })
}
