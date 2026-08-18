// ---------------------------------------------------------------------------
// KV 键设计与常用常量
//   state:{id}      —— 防 CSRF 一次性 state（TTL 7min）
//   session:{id}    —— 登录会话（TTL 30d，可续）
//   user:{githubId} —— 用户档案 + 加密 GitHub token 缓存（避免重复请求）
// ---------------------------------------------------------------------------

import type { Env } from "../index"

/** KV 键前缀封装 */
export const kvKeys = {
  state: (id: string) => `state:${id}`,
  session: (id: string) => `session:${id}`,
  user: (githubId: string) => `user:${githubId}`,
} as const

/** 会话 TTL（秒） */
export function sessionTtl(env: Env): number {
  return Number(env.SESSION_TTL_SECONDS ?? 30 * 24 * 60 * 60)
}

/** state TTL（秒） */
export function stateTtl(env: Env): number {
  return Number(env.STATE_TTL_SECONDS ?? 7 * 60)
}

/** 会话 cookie 名 */
export const SESSION_COOKIE = "ds_session"

/** 令牌换 token 用的 GitHub 端点 */
export const GITHUB_TOKEN_ENDPOINT =
  "https://github.com/login/oauth/access_token"
/** 用户档案端点 */
export const GITHUB_USER_ENDPOINT = "https://api.github.com/user"

/** 默认 OAuth scope：基础用户信息 + repo（读写 issue / discussion） */
export const DEFAULT_OAUTH_SCOPE = "read:user user:email repo"
