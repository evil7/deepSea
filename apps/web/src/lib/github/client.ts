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
    async hook(request, route, parameters) {
      const t = token
      const endpoint = request.endpoint.merge(route, parameters)
      if (t) {
        endpoint.headers.authorization = withAuthorizationPrefix(t)
      }
      return request(endpoint)
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
  return graphqlRequest<T>({
    query,
    ...variables,
    headers: t ? { authorization: `Bearer ${t}` } : {},
  })
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
