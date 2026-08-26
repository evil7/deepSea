// ---------------------------------------------------------------------------
// cookie 读写（Worker 无内置 cookie 解析）
// ---------------------------------------------------------------------------

/** 解析 Cookie 请求头为键值对象 */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name) out[name] = decodeURIComponent(value)
  }
  return out
}

interface CookieOptions {
  maxAge?: number
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Lax" | "Strict" | "None"
}

/** 序列化 Set-Cookie 值 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly) parts.push("HttpOnly")
  if (options.secure) parts.push("Secure")
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  return parts.join("; ")
}

/**
 * 强制过期 cookie 的 Set-Cookie 值（Max-Age=0）。
 * 用于「旧凭据失效 / 重新授权 / OAuth 失败」时清掉浏览器残留的失效会话 cookie，
 * 避免失效 ds_session 持续触发 /auth/login 短路造成假登录态循环。
 */
export function expireCookie(name: string): string {
  return serializeCookie(name, "", {
    maxAge: 0,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  })
}
