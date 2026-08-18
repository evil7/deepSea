// ---------------------------------------------------------------------------
// GitHub OAuth / API 交互（原生 fetch，避免引入 octokit 依赖）
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { GITHUB_TOKEN_ENDPOINT, GITHUB_USER_ENDPOINT } from "./kv"

/** GitHub 用户档案（scope: read:user user:email repo） */
export interface GitHubUser {
  id: number
  login: string
  email: string | null
  avatar_url: string
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
  }
  return {
    id: data.id,
    login: data.login,
    email: data.email,
    avatar_url: data.avatar_url,
  }
}
