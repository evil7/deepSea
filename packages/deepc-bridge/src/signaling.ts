/**
 * deepc 信令客户端 —— 经 Worker `/auth/signal/*` 交换密文 SDP。
 *
 * 注意：信令 payload 已是 AES-GCM 密文（由 crypto.ts 派生密钥加密），
 * 本模块只做 HTTP 透传，不接触明文。
 */

export type SignalKind = "offer" | "answer"

/**
 * 信令服务基址。
 * 本地 dev:all 测试用 worker（8787 的 /auth/signal/*，统一 127.0.0.1）；生产部署改为 deepc.cn。
 * 运行时仍可用 URL 参数 ?signalBase=xxx 覆盖。
 */
export const DEFAULT_SIGNAL_BASE = "http://127.0.0.1:8787"

/** 单次信令操作。 */
interface SignalResult {
  ok: boolean
  payload?: string
  error?: string
  remainingAttempts?: number
  retryAfter?: number
}

/** 写入信令（密文），返回是否成功。 */
export async function putSignal(
  roomId: string,
  kind: SignalKind,
  payload: string,
  baseUrl: string = DEFAULT_SIGNAL_BASE
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/auth/signal/put`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, kind, payload }),
    })
    if (!res.ok) return false
    const body = (await res.json()) as SignalResult
    return body.ok === true
  } catch {
    return false
  }
}

/** 读取信令（一次性消费），返回完整结果（含限流错误信息）。 */
async function getSignalDetail(
  roomId: string,
  kind: SignalKind,
  baseUrl: string = DEFAULT_SIGNAL_BASE
): Promise<SignalResult> {
  try {
    const res = await fetch(`${baseUrl}/auth/signal/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, kind }),
    })
    const body = (await res.json()) as SignalResult
    return body
  } catch {
    return { ok: false, error: "network" }
  }
}

/** 读取信令（一次性消费），返回 payload 或 null。 */
export async function getSignal(
  roomId: string,
  kind: SignalKind,
  baseUrl: string = DEFAULT_SIGNAL_BASE
): Promise<string | null> {
  const body = await getSignalDetail(roomId, kind, baseUrl)
  return body.ok === true && typeof body.payload === "string"
    ? body.payload
    : null
}

/** 轮询结果联合类型（供 client 端感知封禁/剩余次数）。 */
export type PollOutcome =
  | { status: "ok"; payload: string }
  | { status: "timeout"; remainingAttempts?: number }
  | { status: "rate-limited"; retryAfter?: number }

/** 轮询读取信令直到拿到或超时（返回详细结果，client 端用）。 */
export async function pollSignalDetailed(
  roomId: string,
  kind: SignalKind,
  opts: {
    baseUrl?: string
    timeoutMs?: number
    intervalMs?: number
  } = {}
): Promise<PollOutcome> {
  const {
    baseUrl = DEFAULT_SIGNAL_BASE,
    timeoutMs = 60_000,
    intervalMs = 1_000,
  } = opts
  const deadline = Date.now() + timeoutMs
  let lastRemaining: number | undefined
  while (Date.now() < deadline) {
    const body = await getSignalDetail(roomId, kind, baseUrl)
    if (body.ok === true && typeof body.payload === "string") {
      return { status: "ok", payload: body.payload }
    }
    if (body.error === "rate-limited") {
      // 被封禁：立即终止轮询（无需继续消耗），附重试时间。
      return { status: "rate-limited", retryAfter: body.retryAfter }
    }
    if (typeof body.remainingAttempts === "number") {
      lastRemaining = body.remainingAttempts
    }
    await sleep(intervalMs)
  }
  return { status: "timeout", remainingAttempts: lastRemaining }
}

/** 轮询读取信令直到拿到或超时（兼容旧签名，host 端用）。 */
export async function pollSignal(
  roomId: string,
  kind: SignalKind,
  opts: {
    baseUrl?: string
    timeoutMs?: number
    intervalMs?: number
  } = {}
): Promise<string | null> {
  const outcome = await pollSignalDetailed(roomId, kind, opts)
  return outcome.status === "ok" ? outcome.payload : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
