// ---------------------------------------------------------------------------
// GET /auth/me —— 校验会话 cookie，返回用户档案 + access token（供前端 octokit）
//   未登录返回 { authed: false }；已登录返回 { authed: true, user, token }
//   · token 由前端 setGitHubToken() 存入内存，用于 octokit 直调 GitHub API
//   · Worker 只做 auth；所有数据读写在前端用 octokit 完成（不在此代理）
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys } from "../lib/kv"
import { parseCookies } from "../lib/cookies"
import { decryptToken } from "../lib/crypto"

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]
  if (!sessionId) return json({ authed: false })

  const raw = await env.DEEPSEA_KV.get(kvKeys.session(sessionId))
  if (!raw) return json({ authed: false })

  let userId: string
  try {
    userId = (JSON.parse(raw) as { userId: string }).userId
  } catch {
    return json({ authed: false })
  }

  const userRaw = await env.DEEPSEA_KV.get(kvKeys.user(userId))
  if (!userRaw) return json({ authed: false })

  try {
    const user = JSON.parse(userRaw) as {
      login: string
      email: string | null
      avatar_url: string
      tokenEnc: string
    }
    // 解密 token 供前端 octokit 直调（不落盘，仅本次响应）
    const encKey = env.TOKEN_ENC_KEY ?? env.GITHUB_CLIENT_SECRET
    const token = await decryptToken(encKey, user.tokenEnc)
    if (!token) return json({ authed: false })
    return json({
      authed: true,
      user: {
        id: userId,
        login: user.login,
        email: user.email,
        avatar_url: user.avatar_url,
      },
      token,
    })
  } catch {
    return json({ authed: false })
  }
}
