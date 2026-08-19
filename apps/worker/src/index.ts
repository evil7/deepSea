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

import type { ExportedHandler } from "@cloudflare/workers-types"

import { handleCallback } from "./auth/callback"
import { handleLogin } from "./auth/login"
import { handleLogout } from "./auth/logout"
import { handleMe } from "./auth/me"

/** Worker 环境变量 / 绑定 */
export interface Env {
  /** KV：state / session / user（token 加密缓存） */
  DEEPSEA_KV: KVNamespace
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
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url)

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
      default:
        break
    }

    // 其余请求回退到静态资源（SPA 路由由 assets 的 single-page-application 处理）
    return env.ASSETS.fetch(request)
  },
}

export default handler
