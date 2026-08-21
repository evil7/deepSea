// ---------------------------------------------------------------------------
// GET /auth/login —— 发起 GitHub OAuth 授权
//   1. 若已登录（session cookie 有效）→ 直接 302 回 {redirect}，不再走 GitHub
//   2. 未登录：生成一次性 state 存 KV（防 CSRF，TTL 7min）→ 302 GitHub authorize
// 参数：?redirect=/xxx（可选，回跳路径，默认 /）；?reauthorize=1（强制重新走授权）
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  SESSION_COOKIE,
  kvKeys,
  stateTtl,
} from "../lib/kv"
import { parseCookies } from "../lib/cookies"

export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url)
  const redirect = url.searchParams.get("redirect") ?? "/"
  const reauthorize = url.searchParams.get("reauthorize") === "1"

  // 只允许站内相对路径，防开放重定向
  if (!redirect.startsWith("/") || redirect.startsWith("//")) {
    return new Response("Invalid redirect", { status: 400 })
  }

  // 已登录：直接回跳（不再触发 GitHub 授权）
  // 但 reauthorize=1 时强制重新走 GitHub 授权（用于申请 / 更新 scope）
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]
  if (!reauthorize && sessionId) {
    const raw = await env.DEEPSEA_KV.get(kvKeys.session(sessionId))
    if (raw) {
      return Response.redirect(`${env.DEEPSEA_BASE}${redirect}`, 302)
    }
  }

  const state = crypto.randomUUID()
  await env.DEEPSEA_KV.put(
    kvKeys.state(state),
    JSON.stringify({ redirect, createdAt: Date.now() }),
    { expirationTtl: stateTtl(env) }
  )

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.DEEPSEA_BASE}/auth/callback`,
    // scope 权威来源 = wrangler.toml [vars] 的 GITHUB_OAUTH_SCOPE 环境变量；
    // 改动 scope 只需改 wrangler 配置。此处仅兜底（环境变量缺失时的最小默认）。
    scope: env.GITHUB_OAUTH_SCOPE ?? "read:user public_repo",
    state,
  })
  const authorize =
    env.GITHUB_OAUTH_AUTHORIZE ?? "https://github.com/login/oauth/authorize"

  return Response.redirect(`${authorize}?${params.toString()}`, 302)
}
