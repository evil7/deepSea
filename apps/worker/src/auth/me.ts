// ---------------------------------------------------------------------------
// GET /auth/me —— 校验会话 cookie，返回用户档案 + access token（供前端 octokit）
//   未登录返回 { authed: false }；已登录返回 { authed: true, user, token }
//   · token 由前端 setGitHubToken() 存入内存，用于 octokit 直调 GitHub API
//   · Worker 只做 auth；所有数据读写在前端用 octokit 完成（不在此代理）
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys } from "../lib/kv"
import { expireCookie, parseCookies } from "../lib/cookies"
import { decryptToken } from "../lib/crypto"
import { verifyToken } from "../lib/github"
import {
  deleteUser,
  deleteUserSessions,
  getSession,
  getUser,
  resolveDeviceUserId,
} from "../lib/d1"

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      // 插件端（127.0.0.1:3080）跨域用 device_token 查档案；用户档案非敏感
      // （不含 GitHub token），允许任意 Origin + Authorization 头安全。
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  })
}

/** 统一用户档案字段（D1 行 snake_case / KV JSON camelCase 归一化）。 */
interface UserProfile {
  login: string
  email: string | null
  avatar_url: string
  name: string | null
  bio: string | null
  html_url: string
  followers: number
  following: number
  public_repos: number
  tokenEnc: string
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]

  // 1. 会话：D1 优先，回退 KV（P1 双写过渡，旧 KV-only 会话仍可用）。
  //    cookie 无效时回退 device_token（插件端多端互联场景）。
  let githubId: number | null = null
  let viaDevice = false
  if (sessionId) {
    const d1Session = await getSession(env, sessionId)
    if (d1Session) {
      githubId = d1Session.github_id
    } else {
      const raw = await env.DEEPSEA_KV.get(kvKeys.session(sessionId))
      if (raw) {
        try {
          githubId = Number((JSON.parse(raw) as { userId: string }).userId)
        } catch {
          githubId = null
        }
      }
    }
  }
  if (githubId === null) {
    githubId = await resolveDeviceUserId(request, env)
    viaDevice = githubId !== null
  }
  if (githubId === null) return json({ authed: false })

  // 2. 用户：D1 优先，回退 KV
  let profile: UserProfile
  const d1User = await getUser(env, githubId)
  if (d1User) {
    profile = {
      login: d1User.login,
      email: d1User.email,
      avatar_url: d1User.avatar_url,
      name: d1User.name,
      bio: d1User.bio,
      html_url: d1User.html_url,
      followers: d1User.followers,
      following: d1User.following,
      public_repos: d1User.public_repos,
      tokenEnc: d1User.token_enc,
    }
  } else {
    const userRaw = await env.DEEPSEA_KV.get(kvKeys.user(String(githubId)))
    if (!userRaw) return json({ authed: false })
    try {
      const u = JSON.parse(userRaw) as {
        login: string
        email: string | null
        avatar_url: string
        tokenEnc: string
        name?: string | null
        bio?: string | null
        html_url?: string
        followers?: number
        following?: number
        public_repos?: number
      }
      profile = {
        login: u.login,
        email: u.email,
        avatar_url: u.avatar_url,
        name: u.name ?? null,
        bio: u.bio ?? null,
        html_url: u.html_url ?? `https://github.com/${u.login}`,
        followers: u.followers ?? 0,
        following: u.following ?? 0,
        public_repos: u.public_repos ?? 0,
        tokenEnc: u.tokenEnc,
      }
    } catch {
      return json({ authed: false })
    }
  }

  // 3. device_token 鉴权：返回轻量档案（不含 GitHub token —— 配置同步走 D1，
  //    插件端不再直调 gist，故不下发 token）。
  if (viaDevice) {
    return json({
      authed: true,
      user: {
        id: String(githubId),
        login: profile.login,
        avatar_url: profile.avatar_url,
        name: profile.name,
      },
    })
  }

  // 4. 解密 token（仅 cookie 主站会话需要，供前端 octokit 直调）。
  const encKey = env.TOKEN_ENC_KEY ?? env.GITHUB_CLIENT_SECRET
  const token = await decryptToken(encKey, profile.tokenEnc)
  if (!token) return json({ authed: false })

  // 5. token 有效性校验：GitHub 明确拒绝（撤销/过期）时清理 D1 + KV 缓存 + 会话，
  // 返回 tokenExpired 供前端清 sessionStorage 并引导重新授权；网络错误降级
  // 视为有效（避免 GitHub 抖动误清登录态）。
  const verify = await verifyToken(token)
  if (verify === "invalid") {
    await deleteUser(env, githubId)
    await deleteUserSessions(env, githubId)
    await env.DEEPSEA_KV.delete(kvKeys.user(String(githubId)))
    await env.DEEPSEA_KV.delete(kvKeys.session(sessionId))
    // 同步强制过期浏览器 cookie：否则下次 /auth/login 仍会先被失效 cookie 短路判断。
    const headers = new Headers(json({ authed: false, tokenExpired: true }).headers)
    headers.set("Set-Cookie", expireCookie(SESSION_COOKIE))
    return new Response(
      JSON.stringify({ authed: false, tokenExpired: true }),
      { status: 200, headers }
    )
  }

  return json({
    authed: true,
    user: {
      id: String(githubId),
      login: profile.login,
      email: profile.email,
      avatar_url: profile.avatar_url,
      name: profile.name,
      bio: profile.bio,
      html_url: profile.html_url,
      followers: profile.followers,
      following: profile.following,
      public_repos: profile.public_repos,
    },
    token,
  })
}
