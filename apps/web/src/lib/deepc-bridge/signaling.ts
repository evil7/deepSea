// ---------------------------------------------------------------------------
// deepc-bridge 浏览器端信令客户端 —— Worker `/auth/signal/*` 密文透传。
// 与 packages/deepc-bridge/src/signaling.ts 对齐。
// ---------------------------------------------------------------------------

export type SignalKind = "offer" | "answer"

/** 信令服务基址（本地 dev:all worker 8787；生产 deepc.cn）。 */
export const DEFAULT_SIGNAL_BASE = "http://127.0.0.1:8787"

interface SignalResult {
  ok: boolean
  payload?: string
  error?: string
  remainingAttempts?: number
  retryAfter?: number
}

async function getSignalDetail(
  roomId: string,
  kind: SignalKind,
  baseUrl: string
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

export type PollOutcome =
  | { status: "ok"; payload: string }
  | { status: "timeout"; remainingAttempts?: number }
  | { status: "rate-limited"; retryAfter?: number }

export async function pollSignalDetailed(
  roomId: string,
  kind: SignalKind,
  opts: { baseUrl?: string; timeoutMs?: number; intervalMs?: number } = {}
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
      return { status: "rate-limited", retryAfter: body.retryAfter }
    }
    if (typeof body.remainingAttempts === "number") {
      lastRemaining = body.remainingAttempts
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { status: "timeout", remainingAttempts: lastRemaining }
}
