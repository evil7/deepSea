// ---------------------------------------------------------------------------
// POST /auth/logout —— 销毁会话（KV 删除 + 清 cookie）
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys } from "../lib/kv"
import { parseCookies, serializeCookie } from "../lib/cookies"
import { appendLog, deleteSession, resolveSessionUserId } from "../lib/d1"

export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]
  // 审计：登出前记录（需先解析用户，session 随后删除）
  const githubId = sessionId ? await resolveSessionUserId(request, env) : null
  if (sessionId) {
    // 双删：D1 sessions 表 + KV 会话（P1 过渡，保证两处都清干净）
    await deleteSession(env, sessionId)
    await env.DEEPSEA_KV.delete(kvKeys.session(sessionId))
  }
  if (githubId !== null) {
    await appendLog(env, {
      githubId,
      event: "auth_logout",
      ip: request.headers.get("CF-Connecting-IP"),
    })
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
