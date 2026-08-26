// ---------------------------------------------------------------------------
// GET /auth/login —— 发起 GitHub OAuth 授权
//   1. 若已登录（session cookie 有效）→ 直接 302 回 {redirect}，不再走 GitHub
//   2. 未登录：生成一次性 state 存 KV（防 CSRF，TTL 7min）→ 302 GitHub authorize
// 参数：?redirect=/xxx（可选，回跳路径，默认 /）；?reauthorize=1（强制重新走授权）
//
// 失效凭据自愈：短路分支会校验 GitHub token 有效性——token 已被 GitHub 撤销/
// 过期时（verifyToken invalid）删除会话 + 强制过期浏览器 cookie，并继续走 GitHub
// OAuth 重新授权，而不是 302 回跳造成「假登录态」反复循环。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  SESSION_COOKIE,
  kvKeys,
  stateTtl,
} from "../lib/kv"
import { expireCookie, parseCookies } from "../lib/cookies"
import { decryptToken } from "../lib/crypto"
import { verifyToken } from "../lib/github"

/**
 * 短路分支：会话存在时校验 GitHub token 是否仍有效。
 * 返回 true = 有效/无法判定（可短路回跳）；false = 已失效（应删会话+清 cookie 重新授权）。
 * KV session 存在 ≠ GitHub token 有效：GitHub 撤销授权 / token 过期时 KV session
 * 仍会存在（TTL 30 天），若直接短路回跳，前端 useAuth 命中 sessionStorage 缓存
 * 不会调 /auth/me，verifyToken 永不执行 → 假登录态循环（点登录反复失败）。
 */
async function sessionTokenStillValid(
  env: Env,
  githubId: string
): Promise<boolean> {
  try {
    const rawUser = await env.DEEPSEA_KV.get(kvKeys.user(githubId))
    if (!rawUser) return true // 无档案缓存无法校验，降级短路（与旧行为一致）
    const u = JSON.parse(rawUser) as { tokenEnc?: string }
    if (!u.tokenEnc) return true
    const encKey = env.TOKEN_ENC_KEY ?? env.GITHUB_CLIENT_SECRET
    const token = await decryptToken(encKey, u.tokenEnc)
    if (!token) return true
    const verify = await verifyToken(token)
    // unknown（网络抖动）降级视为有效，避免 GitHub 抖动误登出；
    // 真失效（401/403）才触发重新授权。
    return verify !== "invalid"
  } catch {
    return true
  }
}

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
  // 但 reauthorize=1 时强制重新走 GitHub 授权（用于申请 / 更新 scope）；
  // 且会话对应 GitHub token 已失效时也强制重新授权（假登录态自愈）。
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]
  if (!reauthorize && sessionId) {
    const raw = await env.DEEPSEA_KV.get(kvKeys.session(sessionId))
    if (raw) {
      let githubId = ""
      try {
        githubId = String(
          (JSON.parse(raw) as { userId: string }).userId
        )
      } catch {
        /* ignore malformed */
      }
      // token 仍有效（或无法判定）→ 短路回跳；失效 → 删会话 + 清 cookie 走重新授权。
      if (!githubId || (await sessionTokenStillValid(env, githubId))) {
        return Response.redirect(`${env.DEEPSEA_BASE}${redirect}`, 302)
      }
      await env.DEEPSEA_KV.delete(kvKeys.session(sessionId))
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

  // 即将跳 GitHub 授权：先强制过期浏览器残留的旧会话 cookie。
  // 否则 OAuth 期间 / 失败后旧 cookie 仍在，前端缓存命中会显示假登录态。
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${authorize}?${params.toString()}`,
      "Set-Cookie": expireCookie(SESSION_COOKIE),
    },
  })
}
