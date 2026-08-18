import { graphql } from "@octokit/graphql"
import { Octokit } from "@octokit/rest"

// ---------------------------------------------------------------------------
// GitHub 客户端（octokit）—— 单一实例
// 规范：组件/页面不得直接 import octokit，必须走 lib/github/ 封装。
// Token 只存内存（模块级变量），禁止 localStorage 明文；未登录以匿名身份访问。
// ---------------------------------------------------------------------------

let token: string | null = null

/** 设置 GitHub token（登录后调用；仅存内存，刷新页面即失效） */
export function setGitHubToken(t: string | null) {
  token = t
}

/** 当前 token（可能为 null = 匿名） */
export function getToken(): string | null {
  return token
}

export const octokit = new Octokit({ auth: token ?? undefined })

export const gql = graphql.defaults({
  headers: token ? { authorization: `Bearer ${token}` } : {},
})

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
