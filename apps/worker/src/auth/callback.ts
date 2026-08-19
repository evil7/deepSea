// ---------------------------------------------------------------------------
// GET /auth/callback —— GitHub OAuth 回调（核心）
//   1. 校验 state（一次性，KV 删除）
//   2. code 换 access_token
//   3. 拉用户档案；token AES-GCM 加密缓存到 KV（避免重复请求 GitHub）
//   4. 签发会话（HttpOnly cookie + KV session）
//   5. 302 回跳 {redirect}?auth=success
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys, sessionTtl } from "../lib/kv"
import { serializeCookie } from "../lib/cookies"
import { encryptToken } from "../lib/crypto"
import { exchangeCode, fetchGitHubUser } from "../lib/github"

/** 构造带 auth 状态的回跳 URL（拼接站点基址为绝对 URL，Response.redirect 要求） */
function backTo(env: Env, redirect: string, auth: "success" | string): string {
  const sep = redirect.includes("?") ? "&" : "?"
  return `${env.DEEPSEA_BASE}${redirect}${sep}auth=${encodeURIComponent(auth)}`
}

export async function handleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")

  const fail = (reason: string) =>
    Response.redirect(backTo(env, "/", `error:${reason}`), 302)

  if (error) return fail(error)
  if (!code || !state) return fail("missing_params")

  // 校验一次性 state
  const rawState = await env.DEEPSEA_KV.get(kvKeys.state(state))
  await env.DEEPSEA_KV.delete(kvKeys.state(state)) // 一次性，无论结果
  if (!rawState) return fail("invalid_state")

  let redirect = "/"
  try {
    redirect = (JSON.parse(rawState) as { redirect?: string }).redirect ?? "/"
  } catch {
    /* ignore malformed */
  }

  // code → token
  const { accessToken, error: exchangeError } = await exchangeCode(env, code)
  if (!accessToken) return fail(exchangeError ?? "token_exchange")

  // token → 用户档案
  const user = await fetchGitHubUser(accessToken)
  if (!user) return fail("user_fetch")

  // token 加密缓存（避免重复请求 GitHub）；无 TOKEN_ENC_KEY 时退化为明文存 KV 的调用约定（生产必须配置）
  const encKey = env.TOKEN_ENC_KEY ?? env.GITHUB_CLIENT_SECRET
  const tokenEnc = await encryptToken(encKey, accessToken)
  await env.DEEPSEA_KV.put(
    kvKeys.user(String(user.id)),
    JSON.stringify({
      login: user.login,
      email: user.email,
      avatar_url: user.avatar_url,
      name: user.name,
      bio: user.bio,
      html_url: user.html_url,
      followers: user.followers,
      following: user.following,
      public_repos: user.public_repos,
      tokenEnc,
      updatedAt: Date.now(),
    })
  )

  // 签发会话
  const sessionId = crypto.randomUUID()
  const ttl = sessionTtl(env)
  await env.DEEPSEA_KV.put(
    kvKeys.session(sessionId),
    JSON.stringify({ userId: String(user.id), createdAt: Date.now() }),
    { expirationTtl: ttl }
  )

  const cookie = serializeCookie(SESSION_COOKIE, sessionId, {
    maxAge: ttl,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  })

  return new Response(null, {
    status: 302,
    headers: {
      Location: backTo(env, redirect, "success"),
      "Set-Cookie": cookie,
    },
  })
}
