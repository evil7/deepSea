// ---------------------------------------------------------------------------
// 双层限流 —— 频次限流（防洪泛）+ 错误限流（防口令暴力猜测）
//
//   · 频次限流：内存滑动窗口（≤5 req/s），按 IP 计数。per-instance 实现，
//     生产多实例下为「每实例 5 req/s」的近似限流（足够拦截洪泛）。
//   · 错误限流：KV 持久（60min 窗口 5 次），按 IP 计数。跨实例、跨请求持久，
//     用于「临时口令猜测」的慢速封禁（与频次限流正交）。
//
// 存储分工（见 docs/deepsea-auth-migration-evaluation.md）：限流是「短期计数 +
// 自动过期」，KV 的 expirationTtl 契合；错误限流需跨请求持久，用 KV；频次限流
// 是毫秒级瞬态，用内存即可。
// ---------------------------------------------------------------------------

import type { Env } from "../index"

/** 从请求头提取客户端 IP（Cloudflare 注入 / 反代透传 / 兜底）。 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  )
}

// ---------------------------------------------------------------------------
// 频次限流（内存滑动窗口）
// ---------------------------------------------------------------------------

/** 每 IP 的请求时间戳队列。 */
const freqBuckets = new Map<string, number[]>()

/**
 * 频次限流检查：窗口内请求数是否超限。
 * @returns ok=false 时附 retryAfter（秒）。
 */
export function checkFreqLimit(
  ip: string,
  limit = 5,
  windowMs = 1000
): { ok: boolean; retryAfter?: number } {
  const now = Date.now()
  const arr = (freqBuckets.get(ip) ?? []).filter((t) => now - t < windowMs)
  if (arr.length >= limit) {
    freqBuckets.set(ip, arr)
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)),
    }
  }
  arr.push(now)
  freqBuckets.set(ip, arr)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 错误限流（KV 持久，60min 窗口 5 次）
// ---------------------------------------------------------------------------

const ERR_WINDOW_MS = 60 * 60 * 1000
const ERR_MAX = 5

const errKey = (ip: string): string => `ratelimit:${ip}:signal-err`

interface ErrState {
  count: number
  windowStart: number
}

async function readErrState(env: Env, ip: string): Promise<ErrState> {
  const raw = await env.DEEPSEA_KV.get(errKey(ip))
  if (!raw) return { count: 0, windowStart: Date.now() }
  try {
    const parsed = JSON.parse(raw) as ErrState
    return parsed
  } catch {
    return { count: 0, windowStart: Date.now() }
  }
}

/** 错误限流检查：是否已被封禁。ok=false 时附 retryAfter（秒）。 */
export async function checkErrorLimit(
  env: Env,
  ip: string
): Promise<{ ok: boolean; remaining: number; retryAfter?: number }> {
  const state = await readErrState(env, ip)
  // 窗口过期 → 视为未封禁（下次记录时重置）
  if (Date.now() - state.windowStart > ERR_WINDOW_MS) {
    return { ok: true, remaining: ERR_MAX }
  }
  if (state.count >= ERR_MAX) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.ceil(
        (state.windowStart + ERR_WINDOW_MS - Date.now()) / 1000
      ),
    }
  }
  return { ok: true, remaining: ERR_MAX - state.count }
}

/**
 * 记录一次「口令错误」，返回记录后的剩余尝试次数。
 *
 * roomId 去重（关键）：client 正常配对时 poll 是「每秒 get 一次直到命中」，
 * 若口令错误会持续 not-found（约 60 次）。若不按 roomId 去重，5 次 not-found
 * 即在 5 秒内误封禁正常用户。按「同一 IP + 同一 roomId 窗口内只计一次」，
 * 一次口令错误 = 1 次计数，5 个不同错误口令后才封禁。
 */
export async function recordError(
  env: Env,
  ip: string,
  roomId: string
): Promise<number> {
  const roomErrKey = `ratelimit:${ip}:signal-err-room:${roomId}`
  const ttl = Math.ceil(ERR_WINDOW_MS / 1000)
  const already = await env.DEEPSEA_KV.get(roomErrKey)

  const state = await readErrState(env, ip)
  if (Date.now() - state.windowStart > ERR_WINDOW_MS) {
    state.count = 0
    state.windowStart = Date.now()
  }

  if (!already) {
    await env.DEEPSEA_KV.put(roomErrKey, "1", { expirationTtl: ttl })
    state.count += 1
    await env.DEEPSEA_KV.put(errKey(ip), JSON.stringify(state), {
      expirationTtl: ttl,
    })
  }

  return Math.max(0, ERR_MAX - state.count)
}
