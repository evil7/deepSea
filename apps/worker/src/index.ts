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
import { handleInterconnectLog } from "./auth/preferences"
import {
  handleNodeList,
  handleNodeRegister,
  handleNodeRemove,
} from "./auth/node"
import {
  handleDeviceGrant,
  handleDeviceGrantPoll,
} from "./auth/device"
import { handleConfigList, handleConfigPut } from "./auth/config"
import { purgeLogs, resolveActorUserId, resolveDeviceUserIdFromToken } from "./lib/d1"
import { checkFreqLimit, getClientIp } from "./lib/ratelimit"
import { SignalRoom } from "./durable/signal-room"

/** Worker 环境变量 / 绑定 */
export interface Env {
  /** KV：state / session / user / deviceGrant（设备授权码）/ 限流计数 */
  DEEPSEA_KV: KVNamespace
  /** D1：用户 / 会话 / profile（关系型） */
  DEEPSEA_D1: D1Database
  /** 静态资源绑定（../web/dist 构建产物） */
  ASSETS: Fetcher
  /** DO 信号房（WS 推送，方案 A；分区键 room:{githubId}） */
  SIGNAL_ROOM: DurableObjectNamespace
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
  /** 设备授权码 TTL（秒，state 换取 token 窗口，默认 5 分钟） */
  DEVICE_GRANT_TTL_SECONDS?: string
  /** device_token 有效期（秒，默认 30 天） */
  DEVICE_TOKEN_TTL_SECONDS?: string
}

/** 需要跨域 CORS 的 /auth/* 路径（插件端/主站跨源调用：设备 + 授权 + me）。 */
function isCorsAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith("/auth/node/") ||
    pathname.startsWith("/auth/config") ||
    pathname === "/auth/device-grant" ||
    pathname === "/auth/device-grant/poll" ||
    pathname === "/auth/me"
  )
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url)

    // 跨源 CORS preflight（OPTIONS）
    if (request.method === "OPTIONS" && isCorsAuthPath(url.pathname)) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      })
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
              ...(isCorsAuthPath(url.pathname)
                ? {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                  }
                : {}),
            },
          }
        )
      }
    }

    // WebSocket 信令（DO 信号房）：Upgrade 请求路由到 room:{githubId}。
    // worker 层先拿 githubId 确定分区；DO 层再做完整认证 + nodeId 归属校验。
    if (url.pathname === "/ws/signal") {
      let githubId = await resolveActorUserId(request, env)
      if (githubId === null) {
        const token = url.searchParams.get("token")
        if (token) githubId = await resolveDeviceUserIdFromToken(token, env)
      }
      if (githubId === null) return new Response("unauthorized", { status: 401 })
      const id = env.SIGNAL_ROOM.idFromName(`room:${githubId}`)
      const stub = env.SIGNAL_ROOM.get(id)
      return stub.fetch(request)
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
      case "/auth/interconnect-log":
        return handleInterconnectLog(request, env)
      case "/auth/node/register":
        return handleNodeRegister(request, env)
      case "/auth/node/list":
        return handleNodeList(request, env)
      case "/auth/node/remove":
        return handleNodeRemove(request, env)
      case "/auth/device-grant":
        return handleDeviceGrant(request, env)
      case "/auth/device-grant/poll":
        return handleDeviceGrantPoll(request, env)
      case "/auth/config/list":
        return handleConfigList(request, env)
      case "/auth/config/put":
        return handleConfigPut(request, env)
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

  // 审计日志 30 天自动清除（Cron 每日触发；见 wrangler.toml [triggers]）。
  async scheduled(_controller, env) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const purged = await purgeLogs(env, cutoff)
    if (purged > 0) {
      console.log(`[audit] purged ${purged} interconnect_log rows older than 30d`)
    }
  },
}

export default handler

// DO 信号房（wrangler.toml [[durable_objects.bindings]] class_name 需从 main 模块导出）。
export { SignalRoom }
