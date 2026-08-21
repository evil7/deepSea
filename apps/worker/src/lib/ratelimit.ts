// ---------------------------------------------------------------------------
// 频次限流（防洪泛）—— 内存滑动窗口（≤5 req/s），按 IP 计数。
// per-instance 实现，生产多实例下为「每实例 5 req/s」的近似限流（足够拦截洪泛）。
// 毫秒级瞬态计数，用内存即可（无 KV 依赖）。
// ---------------------------------------------------------------------------

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
