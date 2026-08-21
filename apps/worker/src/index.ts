// ---------------------------------------------------------------------------
// deepSea Worker —— GitHub OAuth 登录 + 静态资源托管
//
// 职责（【架构红线】只做 auth，不承载任何业务数据代理）：
//   1. /auth/* 路由：GitHub OAuth 授权（state 防 CSRF、code 换 token、
//      KV 会话、token 加密缓存）+ /auth/me 返回 access token 供前端 octokit
//   2. 其余请求回退到静态资源（ASSETS binding，指向 ../web/dist）
//   · 所有 GitHub 数据读写（discussions / search / issues 等）由前端
//     lib/github/ 用 octokit 直调官方 API，不经 Worker。
//
// 部署：先构建 web（pnpm --filter @deepsea/web build），再 wrangler deploy。
// 详细构思见 docs/deepsea-oauth-worker.md。
// ---------------------------------------------------------------------------

import { handleCallback } from "./auth/callback"
import { handleLogin } from "./auth/login"
import { handleLogout } from "./auth/logout"
import { handleMe } from "./auth/me"
import {
  handleInterconnectLog,
  handlePreferencesGet,
  handlePreferencesPut,
} from "./auth/preferences"
import { handleSignalGet, handleSignalOptions, handleSignalPut } from "./auth/signal"
import { checkFreqLimit, getClientIp } from "./lib/ratelimit"

/** Worker 环境变量 / 绑定 */
export interface Env {
  /** KV：state / 临时口令信令（signal）/ 限流计数 */
  DEEPSEA_KV: KVNamespace
  /** D1：用户 / 会话 / profile（关系型） */
  DEEPSEA_D1: D1Database
  /** 静态资源绑定（../web/dist 构建产物） */
  ASSETS: Fetcher
  /** 站点基址：OAuth callback 为 {DEEPSEA_BASE}/auth/callback */
  DEEPSEA_BASE: string
  /** GitHub OAuth App client_id（secret 注入） */
  GITHUB_CLIENT_ID: string
  /** GitHub OAuth App client_secret（secret 注入） */
  GITHUB_CLIENT_SECRET: string
  /** GitHub OAuth 授权端点（默认 github.com） */
  GITHUB_OAUTH_AUTHORIZE?: string
  /** 申请 scope（默认 "read:user public_repo"：公开仓库写 discussions，最小授权） */
  GITHUB_OAUTH_SCOPE?: string
  /** token 加密派生密钥（secret 注入） */
  TOKEN_ENC_KEY?: string
  /** 会话 TTL（秒，默认 30 天） */
  SESSION_TTL_SECONDS?: string
  /** state TTL（秒，默认 7 分钟） */
  STATE_TTL_SECONDS?: string
  /** 信令 TTL（秒，临时口令有效期，默认 60s） */
  SIGNAL_TTL_SECONDS?: string
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url)

    // 信令 CORS preflight（OPTIONS）
    if (
      request.method === "OPTIONS" &&
      (url.pathname === "/auth/signal/put" || url.pathname === "/auth/signal/get")
    ) {
      return handleSignalOptions()
    }

    // 频次限流：信令 + 登录接口统一按 IP ≤5 req/s（防洪泛）。
    // OPTIONS preflight 与静态资源不占用额度。
    if (url.pathname.startsWith("/auth/") && request.method !== "OPTIONS") {
      const rl = checkFreqLimit(getClientIp(request))
      if (!rl.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: "rate-limited" }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Retry-After": String(rl.retryAfter ?? 1),
              ...(url.pathname.startsWith("/auth/signal/")
                ? {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                  }
                : {}),
            },
          }
        )
      }
    }

    // OAuth 路由由 Worker 处理（auth 到此为止，数据读写都在前端 octokit）
    switch (url.pathname) {
      case "/auth/login":
        return handleLogin(request, env)
      case "/auth/callback":
        return handleCallback(request, env)
      case "/auth/me":
        return handleMe(request, env)
      case "/auth/logout":
        return handleLogout(request, env)
      case "/auth/preferences":
        return request.method === "PUT"
          ? handlePreferencesPut(request, env)
          : handlePreferencesGet(request, env)
      case "/auth/interconnect-log":
        return handleInterconnectLog(request, env)
      case "/auth/signal/put":
        return handleSignalPut(request, env)
      case "/auth/signal/get":
        return handleSignalGet(request, env)
      default:
        break
    }

    // Worker 只做 auth，不承载 /api/* 业务数据代理（架构红线）。
    // 注意：当前 wrangler.toml 的 run_worker_first 未含 /api/*（asset-first 优先），
    // 故此分支在 dev 下通常是死代码——/api/* 会先被 ASSETS 处理。保留它作为
    // 架构意图声明：任何 /api/* 到达 Worker 都是异常（正常应由前端 octokit 直调
    // GitHub，或 deepc 数据面经 DataChannel 桥接，不该走真实网络）。
    if (url.pathname.startsWith("/api/")) {
      return new Response(
        JSON.stringify({ ok: false, error: "not-found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      )
    }

    // 其余请求回退到静态资源（SPA 路由由 assets 的 single-page-application 处理）
    return env.ASSETS.fetch(request)
  },
}

export default handler
