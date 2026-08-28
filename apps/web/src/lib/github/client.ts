import { graphql as graphqlRequest } from "@octokit/graphql"
import { Octokit } from "@octokit/rest"

// ---------------------------------------------------------------------------
// GitHub 客户端（octokit）—— 单一实例
// 规范：组件/页面不得直接 import octokit，必须走 lib/github/ 封装。
// Token 由 useAuth 注入（sessionStorage 会话内暂留 → 注入内存模块变量），
// 禁止 localStorage 明文；未登录以匿名身份访问。
// GraphQL（discussions 等）每次请求动态读 token —— 登录后无需重建客户端。
// ---------------------------------------------------------------------------

let token: string | null = null

/** 授权失效事件名（token 被撤销/过期，前端各 useAuth 实例监听后统一登出）。 */
export const AUTH_EXPIRED_EVENT = "deepsea:auth-expired"

/**
 * 广播「授权已失效」：由 octokit 401 检测触发，通知所有 useAuth 实例清缓存登出。
 * 用事件而非模块级回调，避免多个 useAuth 实例（topbar/links 等）互相覆盖 handler。
 */
export function notifyAuthExpired(): void {
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
}

/** 设置 GitHub token（登录后由 useAuth 注入；sessionStorage 会话内暂留，关标签页失效） */
export function setGitHubToken(t: string | null) {
  token = t
}

/** 当前 token（可能为 null = 匿名） */
export function getToken(): string | null {
  return token
}

/** 给 token 加 "Bearer " 前缀（对齐 @octokit/auth-token 的 withAuthorizationPrefix） */
function withAuthorizationPrefix(t: string): string {
  if (/^(token|bearer) +/i.test(t)) {
    return t
  }
  return `Bearer ${t}`
}

// REST 客户端：用自定义 auth strategy 动态读取 token（登录后无需重建实例）。
// ⚠️ authStrategy 返回的对象必须同时含 `auth` 与 `hook` 两个方法：
//   · `auth()`      —— 返回认证结果（token / unauthenticated）
//   · `hook()`      —— 每次 REST 请求注入 authorization 头
// octokit core 会执行 `hook.wrap("request", auth.hook)`，缺 hook 会在发请求前
// 抛 "Cannot read properties of undefined (reading 'bind')"，导致所有 octokit
// REST 调用（repos.get / search / issues）静默失败。
// hook 签名复刻 @octokit/auth-token 的 `hook(token, request, route, parameters)`。
export const octokit = new Octokit({
  authStrategy: () => ({
    async auth() {
      const t = token
      return t
        ? { type: "token" as const, token: t, tokenType: "oauth" }
        : { type: "unauthenticated" }
    },
    // request 类型为 @octokit/types 的 RequestInterface（未直接依赖，用 any
    // 规避幽灵依赖；octokit 的 authStrategy 本身也是 any 类型）
    async hook(
      request: any,
      route: string,
      parameters?: Record<string, unknown>
    ) {
      const t = token
      const endpoint = request.endpoint.merge(route, parameters)
      if (t) {
        endpoint.headers.authorization = withAuthorizationPrefix(t)
      }
      const response = await request(endpoint)
      // token 失效检测：401 表示授权已被撤销/过期（区别于 5xx/网络错误，
      // 后者会正常抛错由调用方处理，不触发登出）。
      if (t && response.status === 401) notifyAuthExpired()
      return response
    },
  }),
})

/**
 * GraphQL 查询（动态鉴权）：每次请求读取当前 token，登录后无需重建客户端。
 * 用法：await githubGraphQL(query, variables)
 * 注意：@octokit/graphql v7+ 对象形式将变量展开到顶层（variables 键已弃用），
 *       此处手动展开以兼容。
 */
export async function githubGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const t = token
  try {
    return await graphqlRequest<T>({
      query,
      ...variables,
      headers: t ? { authorization: `Bearer ${t}` } : {},
    })
  } catch (error) {
    // GraphQL 401 → token 失效（@octokit/graphql 抛 HttpError，含 status）
    const status = (error as { status?: number } | null)?.status
    if (t && status === 401) notifyAuthExpired()
    throw error
  }
}

/** 限流剩余/总量（用于 UI 提示），取不到返回 null */
export async function getRateLimit(): Promise<{
  remaining: number
  limit: number
  resetAt: number
} | null> {
  try {
    const rl = await octokit.request("GET /rate_limit")
    const core = rl.data.resources.core
    return {
      remaining: core.remaining,
      limit: core.limit,
      resetAt: core.reset,
    }
  } catch {
    return null
  }
}

/** GitHub 用户搜索结果项（供屏蔽用户搜索下拉） */
export interface UserSearchItem {
  login: string
  /** 展示名（可能为空） */
  name: string | null
  avatarUrl: string
}

/**
 * 搜索 GitHub 用户（REST GET /search/users，需登录）。
 * 未登录 / 失败 / 无结果返回空数组（不抛错）。
 * @param q 查询串（仅 login，防止 @ 干扰）
 * @param perPage 结果数（≤100；默认 20，需求至多 50 可传 50）
 */
export async function searchUsers(
  q: string,
  perPage = 20
): Promise<UserSearchItem[]> {
  const t = token
  if (!t) return []
  const clean = q.trim().replace(/^@/, "").replace(/\s+/g, " ")
  if (!clean) return []
  try {
    const res = await octokit.request("GET /search/users", {
      q: `${clean} in:login`,
      per_page: Math.min(50, Math.max(1, perPage)),
    })
    const items = res.data.items as Array<{
      login: string
      name?: string | null
      avatar_url?: string
    }>
    return (items ?? [])
      .filter((u) => typeof u?.login === "string" && u.login.length > 0)
      .map((u) => ({
        login: u.login,
        name: u.name ?? null,
        avatarUrl: u.avatar_url ?? "",
      }))
  } catch {
    return []
  }
}
