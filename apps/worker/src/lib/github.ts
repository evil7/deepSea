// ---------------------------------------------------------------------------
// GitHub OAuth / API 交互（原生 fetch，避免引入 octokit 依赖）
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { GITHUB_TOKEN_ENDPOINT, GITHUB_USER_ENDPOINT } from "./kv"

/** GitHub 用户档案（scope: read:user public_repo） */
export interface GitHubUser {
  id: number
  login: string
  email: string | null
  avatar_url: string
  name: string | null
  bio: string | null
  html_url: string
  followers: number
  following: number
  public_repos: number
}

/** code 换 access_token（GitHub OAuth Web Flow） */
export async function exchangeCode(
  env: Env,
  code: string
): Promise<{ accessToken: string; error?: string }> {
  let res: Response
  try {
    res = await fetch(GITHUB_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "deepsea",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${env.DEEPSEA_BASE}/auth/callback`,
      }),
    })
  } catch {
    return { accessToken: "", error: "network_error" }
  }
  const data = (await res.json()) as {
    access_token?: string
    error?: string
  }
  if (!data.access_token) {
    return { accessToken: "", error: data.error ?? "token_exchange_failed" }
  }
  return { accessToken: data.access_token }
}

/** 用 access_token 拉取用户档案 */
export async function fetchGitHubUser(
  accessToken: string
): Promise<GitHubUser | null> {
  let res: Response
  try {
    res = await fetch(GITHUB_USER_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "deepsea",
      },
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const data = (await res.json()) as {
    id: number
    login: string
    email: string | null
    avatar_url: string
    name: string | null
    bio: string | null
    html_url: string
    followers: number
    following: number
    public_repos: number
  }
  return {
    id: data.id,
    login: data.login,
    email: data.email,
    avatar_url: data.avatar_url,
    name: data.name ?? null,
    bio: data.bio ?? null,
    html_url: data.html_url ?? `https://github.com/${data.login}`,
    followers: data.followers ?? 0,
    following: data.following ?? 0,
    public_repos: data.public_repos ?? 0,
  }
}

/**
 * 校验 access_token 是否仍被 GitHub 认可（/auth/me 用，防「token 已撤销但 KV
 * 缓存仍在」的假登录态）。
 *
 * 三态结果，关键区分「真失效」与「网络故障」：
 *   · 'valid'   —— GitHub 明确认可 token（2xx）
 *   · 'invalid' —— GitHub 明确拒绝（401/403：token 已撤销/过期/权限不足）
 *   · 'unknown' —— 网络错误/超时等无法判定，**降级视为有效**（避免误清登录态）
 */
export async function verifyToken(
  accessToken: string
): Promise<"valid" | "invalid" | "unknown"> {
  let res: Response
  try {
    res = await fetch(GITHUB_USER_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "deepsea",
      },
    })
  } catch {
    return "unknown"
  }
  if (res.status === 401 || res.status === 403) return "invalid"
  if (res.ok) return "valid"
  return "unknown"
}
