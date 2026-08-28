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
import { useSearchParams } from "react-router-dom"

import { AUTH_EXPIRED_EVENT, setGitHubToken } from "@/lib/github/client"

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
  /** GitHub token 已失效（被撤销 / 过期 / 无法解密），需重新授权 */
  tokenExpired?: boolean
  /** 账号已销毁（24h 撤回窗口内）：有轻量档案、无 token */
  destroyed?: boolean
  destroyedAt?: number
}

/** sessionStorage 键：登录态（user + token）会话内暂留 */
const AUTH_STORAGE_KEY = "deepsea:auth"

/**
 * 会话缓存 TTL：超过后视为过期，回源 /auth/me 校验（Worker 会验证 token 是否
 * 仍被 GitHub 认可）。平衡「减少打鉴权接口」与「及时捕捉 token 被撤销」。
 */
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000

/** 读 sessionStorage 缓存的登录态（无效 / 缺失 / 超 TTL 返回 null） */
function readCached(): { user: AuthUser; token: string } | null {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as {
      user?: AuthUser
      token?: string
      cachedAt?: number
    }
    if (data?.user?.login && data?.token) {
      // 超 TTL：清缓存并返回 null，强制回源 /auth/me 校验 token 有效性
      if (
        typeof data.cachedAt === "number" &&
        Date.now() - data.cachedAt > AUTH_CACHE_TTL_MS
      ) {
        sessionStorage.removeItem(AUTH_STORAGE_KEY)
        return null
      }
      return { user: data.user, token: data.token }
    }
    return null
  } catch {
    return null
  }
}

/** 写 / 清 sessionStorage 缓存（隐私模式等极端情况静默忽略）；写入时记录缓存时间戳。 */
function writeCached(data: { user: AuthUser; token: string } | null): void {
  try {
    if (data) {
      sessionStorage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({ ...data, cachedAt: Date.now() })
      )
    } else {
      sessionStorage.removeItem(AUTH_STORAGE_KEY)
    }
  } catch {
    // ignore
  }
}

/**
 * in-flight 单例：并发调用（App/Topbar/LinksPage 各自 useAuth 首次挂载）复用同一
 * 请求，避免一次页面加载对 /auth/me 发多次并发请求（P0-1 消除业务自身浪费）。
 */
let fetchMeInFlight: Promise<{ user: AuthUser; token: string } | null> | null =
  null

/** 读取当前登录用户 + token（未登录返回 null；网络错误返回 null 不抛错）。
 * 账号已销毁（destroyed）时返回 { destroyedAt } 标记，token 为空。 */
function fetchMe(): Promise<{
  user: AuthUser
  token: string
  destroyedAt: number | null
} | null> {
  if (fetchMeInFlight) return fetchMeInFlight
  fetchMeInFlight = (async () => {
    try {
      const res = await fetch("/auth/me", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
      if (!res.ok) return null
      const data = (await res.json()) as MeResponse
      // token 已失效（撤销/过期/无法解密）：立即清缓存。否则缓存命中后
      // octokit 调 GitHub API 会 401 二次探测（多一次请求 + 广播事件）；
      // 直接清空让 RequireAuth 走重新授权，少一次往返。
      if (data.tokenExpired) {
        sessionStorage.removeItem(AUTH_STORAGE_KEY)
        return null
      }
      // 已销毁账号：轻量档案可展示（设置页待销毁状态），无 token。
      if (data.destroyed && data.user && data.destroyedAt) {
        return { user: data.user, token: "", destroyedAt: data.destroyedAt }
      }
      if (!data.authed || !data.user || !data.token) return null
      return { user: data.user, token: data.token, destroyedAt: null }
    } catch {
      return null
    } finally {
      // 请求结束后清空引用，允许下次（如登录回跳强制刷新）重新请求。
      fetchMeInFlight = null
    }
  })()
  return fetchMeInFlight
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  /** 账号已销毁的时间戳（null = 正常）；24h 撤回窗口内设置页显示待销毁状态 */
  const [destroyedAt, setDestroyedAt] = useState<number | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  // 仅依赖 search 参数：登录回跳（?auth=success）强制刷新拿新 token；
  // SPA 切换页面（pathname 变化、search 不变）不触发 → 避免反复请求 /auth/me。
  // 主体放 setTimeout 宏任务：避免 effect 同步路径 setState
  // （React Compiler set-state-in-effect lint）；清理时连带取消。
  useEffect(() => {
    let cancelled = false
    const isAuthCallback = searchParams.get("auth") === "success"
    const cached = isAuthCallback ? null : readCached()
    const id = window.setTimeout(() => {
      if (cancelled) return
      if (cached) {
        // 命中会话缓存：直接恢复，零网络请求
        setUser(cached.user)
        setDestroyedAt(null)
        setGitHubToken(cached.token)
        setLoading(false)
        return
      }
      setLoading(true)
      fetchMe().then((result) => {
        if (!cancelled) {
          if (result) {
            setUser(result.user)
            setDestroyedAt(result.destroyedAt)
            if (result.token) {
              // token 注入前端 octokit（仅存内存），供 GitHub API 直调
              setGitHubToken(result.token)
              writeCached(result)
            } else {
              // 已销毁账号：无 token，不写会话缓存
              setGitHubToken(null)
              writeCached(null)
            }
            // 消费 auth=success：登录/续期成功即清理 URL 参数（replace 不产生历史
            // 记录）。否则 ?auth=success 粘滞在 URL 上，每次刷新都强制 fetchMe，
            // 且后续 RequireAuth 拼 redirect 时叠加 auth 参数。
            // 清理触发 search 变化 → effect 重跑 → 命中刚写入的缓存直接恢复，
            // 不会产生第二次网络请求。失败（未登录/过期）不清理：RequireAuth
            // 会整页跳转登录，URL 自然切换，无需在此处理。
            if (isAuthCallback) {
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev)
                  next.delete("auth")
                  return next
                },
                { replace: true }
              )
            }
          } else {
            setUser(null)
            setDestroyedAt(null)
            setGitHubToken(null)
            writeCached(null)
          }
          setLoading(false)
        }
      })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [searchParams, setSearchParams])

  // 监听授权失效事件（octokit 401 检测触发）：token 被撤销/过期时，清缓存
  // 并登出。所有 useAuth 实例（topbar/links 等）各自监听，统一回到未登录态，
  // UI 自然显示「登录」按钮引导重新授权。
  useEffect(() => {
    const onAuthExpired = () => {
      setUser(null)
      setDestroyedAt(null)
      setGitHubToken(null)
      writeCached(null)
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      })
    } finally {
      setUser(null)
      setDestroyedAt(null)
      setGitHubToken(null)
      writeCached(null)
    }
  }, [])

  return { user, loading, logout, destroyedAt }
}
