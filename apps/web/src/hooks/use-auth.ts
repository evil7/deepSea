// ---------------------------------------------------------------------------
// useAuth —— 登录态 hook
//   · 首次挂载优先从 sessionStorage 恢复（user + token），命中则不请求 /auth/me，
//     避免 SPA 切换页面反复打鉴权接口（token 会话生命周期内暂留，关标签页失效）
//   · 无缓存 / 登录回跳（?auth=success）→ 调 /auth/me 拿用户档案 + token，
//     成功后写入 sessionStorage
//   · token 注入前端 octokit（setGitHubToken，仅存内存），供数据读写直调 GitHub
//   · 暴露 { user, loading, logout }
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react"
import { useLocation } from "react-router-dom"

import { setGitHubToken } from "@/lib/github/client"

export interface AuthUser {
  id: string
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

interface MeResponse {
  authed: boolean
  user?: AuthUser
  token?: string
}

/** sessionStorage 键：登录态（user + token）会话内暂留 */
const AUTH_STORAGE_KEY = "deepsea:auth"

/** 读 sessionStorage 缓存的登录态（无效 / 缺失返回 null） */
function readCached(): { user: AuthUser; token: string } | null {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as { user?: AuthUser; token?: string }
    if (data?.user?.login && data?.token) {
      return { user: data.user, token: data.token }
    }
    return null
  } catch {
    return null
  }
}

/** 写 / 清 sessionStorage 缓存（隐私模式等极端情况静默忽略） */
function writeCached(data: { user: AuthUser; token: string } | null): void {
  try {
    if (data) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data))
    } else {
      sessionStorage.removeItem(AUTH_STORAGE_KEY)
    }
  } catch {
    // ignore
  }
}

/** 读取当前登录用户 + token（未登录返回 null；网络错误返回 null 不抛错） */
async function fetchMe(): Promise<{ user: AuthUser; token: string } | null> {
  try {
    const res = await fetch("/auth/me", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return null
    const data = (await res.json()) as MeResponse
    if (!data.authed || !data.user || !data.token) return null
    return { user: data.user, token: data.token }
  } catch {
    return null
  }
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const location = useLocation()

  // 仅依赖 location.search：登录回跳（?auth=success）强制刷新拿新 token；
  // SPA 切换页面（pathname 变化、search 不变）不触发 → 避免反复请求 /auth/me
  useEffect(() => {
    let cancelled = false
    const isAuthCallback = location.search.includes("auth=success")
    const cached = isAuthCallback ? null : readCached()
    if (cached) {
      // 命中会话缓存：直接恢复，零网络请求
      setUser(cached.user)
      setGitHubToken(cached.token)
      setLoading(false)
      return
    }
    setLoading(true)
    fetchMe().then((result) => {
      if (!cancelled) {
        if (result) {
          setUser(result.user)
          // token 注入前端 octokit（仅存内存），供 GitHub API 直调
          setGitHubToken(result.token)
          writeCached(result)
        } else {
          setUser(null)
          setGitHubToken(null)
          writeCached(null)
        }
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [location.search])

  const logout = useCallback(async () => {
    try {
      await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      })
    } finally {
      setUser(null)
      setGitHubToken(null)
      writeCached(null)
    }
  }, [])

  return { user, loading, logout }
}
