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
import { createSession, upsertUser, appendLog } from "../lib/d1"
import { getClientIp } from "../lib/ratelimit"
import { expireCookie, serializeCookie } from "../lib/cookies"
import { encryptToken } from "../lib/crypto"
import { exchangeCode, fetchGitHubUser } from "../lib/github"

/** 构造带 auth 状态的回跳 URL（拼接站点基址为绝对 URL，Response.redirect 要求）。
 * 剥离 redirect 中已有的 auth 参数，避免续期场景叠加（如 /links?auth=success 再拼
 * auth=success → /links?auth=success&auth=success）。 */
function backTo(env: Env, redirect: string, auth: string): string {
  const [path, query = ""] = redirect.split("?")
  const params = new URLSearchParams(query)
  params.delete("auth")
  params.set("auth", auth)
  const qs = params.toString()
  return `${env.DEEPSEA_BASE}${path}${qs ? `?${qs}` : ""}`
}

/** 站内相对路径校验（防开放重定向）。 */
function isSafeRedirect(redirect: string): boolean {
  return redirect.startsWith("/") && !redirect.startsWith("//")
}

/**
 * 从 URL 的 state 参数恢复 redirect（失败路径尽量回跳原位置）。
 * 用于 error（用户取消授权）等 state 尚未消费的场景：state 仍在 KV 中，
 * 读取后消费删除，恢复出原访问位置。state 缺失/过期返回 "/"（无法恢复）。
 */
async function restoreRedirect(
  env: Env,
  stateParam: string | null
): Promise<string> {
  if (!stateParam) return "/"
  try {
    const raw = await env.DEEPSEA_KV.get(kvKeys.state(stateParam))
    if (!raw) return "/"
    await env.DEEPSEA_KV.delete(kvKeys.state(stateParam)) // 一次性，无论结果
    const { redirect } = JSON.parse(raw) as { redirect?: string }
    return redirect && isSafeRedirect(redirect) ? redirect : "/"
  } catch {
    return "/"
  }
}

export async function handleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")

  // 失败回跳时一并强制过期旧会话 cookie：OAuth 失败（GitHub 拒绝/取消/state 过期）
  // 后若残留旧 cookie，前端 useAuth 命中缓存会显示假登录态，再点登录又被 /auth/login
  // 短路 → 反复失败。清 cookie 让下次登录从干净的未登录态重新走 OAuth。
  // ⚠️ redirect 优先回跳原位置：过期自动续期等场景下失败不应把用户踢回首页。
  const fail = (redirect: string, reason: string) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: backTo(env, redirect, `error:${reason}`),
        "Set-Cookie": expireCookie(SESSION_COOKIE),
      },
    })

  // 用户取消授权（GitHub 返回 error）：state 通常仍在 KV，恢复 redirect 回跳原位置
  if (error) {
    return fail(await restoreRedirect(env, state), error)
  }
  if (!code || !state) return fail("/", "missing_params")

  // 校验一次性 state
  const rawState = await env.DEEPSEA_KV.get(kvKeys.state(state))
  await env.DEEPSEA_KV.delete(kvKeys.state(state)) // 一次性，无论结果
  if (!rawState) return fail("/", "invalid_state")

  let redirect = "/"
  try {
    const r = (JSON.parse(rawState) as { redirect?: string }).redirect ?? "/"
    if (isSafeRedirect(r)) redirect = r
  } catch {
    /* ignore malformed */
  }

  // code → token
  const { accessToken, error: exchangeError } = await exchangeCode(env, code)
  if (!accessToken) return fail(redirect, exchangeError ?? "token_exchange")

  // token → 用户档案
  const user = await fetchGitHubUser(accessToken)
  if (!user) return fail(redirect, "user_fetch")

  // token 加密缓存（避免重复请求 GitHub）；无 TOKEN_ENC_KEY 时退化为明文存 KV 的调用约定（生产必须配置）
  const encKey = env.TOKEN_ENC_KEY ?? env.GITHUB_CLIENT_SECRET
  const tokenEnc = await encryptToken(encKey, accessToken)

  // 双写（P1）：KV user 保留（回退兜底）+ D1 users 表（关系型主存储）
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
  await upsertUser(env, {
    githubId: user.id,
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
  })

  // 签发会话
  const sessionId = crypto.randomUUID()
  const ttl = sessionTtl(env)
  await env.DEEPSEA_KV.put(
    kvKeys.session(sessionId),
    JSON.stringify({ userId: String(user.id), createdAt: Date.now() }),
    { expirationTtl: ttl }
  )
  // 双写（P1）：D1 sessions 表（支持多端会话 + 审计）
  await createSession(env, {
    id: sessionId,
    githubId: user.id,
    expiresAt: Date.now() + ttl * 1000,
    userAgent: request.headers.get("User-Agent"),
    ip: getClientIp(request),
  })

  const cookie = serializeCookie(SESSION_COOKIE, sessionId, {
    maxAge: ttl,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  })

  // 审计：登录成功（web 端用户操作事件）。
  await appendLog(env, {
    githubId: user.id,
    event: "auth_login",
    ip: getClientIp(request),
  })

  return new Response(null, {
    status: 302,
    headers: {
      Location: backTo(env, redirect, "success"),
      "Set-Cookie": cookie,
    },
  })
}
