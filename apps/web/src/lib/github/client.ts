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

// REST 客户端：用自定义 auth strategy 动态读取 token（登录后无需重建实例）。
// Octokit 的 `auth` 字段只接受 string/object/strategy，不接受 `() => token`
// （会抛 "Token passed to createTokenAuth is not a string"）。自定义 strategy
// 返回 `{ token }` 时按 Bearer 注入；token 为空则返回 {} 匿名。
export const octokit = new Octokit({
  authStrategy: () => ({
    async auth() {
      const t = token
      return t ? { type: "token" as const, token: t, tokenType: "oauth" } : {}
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
