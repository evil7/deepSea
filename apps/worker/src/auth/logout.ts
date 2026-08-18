// ---------------------------------------------------------------------------
// POST /auth/logout —— 销毁会话（KV 删除 + 清 cookie）
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys } from "../lib/kv"
import { parseCookies, serializeCookie } from "../lib/cookies"

export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]
  if (sessionId) {
    await env.DEEPSEA_KV.delete(kvKeys.session(sessionId))
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": serializeCookie(SESSION_COOKIE, "", {
        maxAge: 0,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      }),
    },
  })
}
