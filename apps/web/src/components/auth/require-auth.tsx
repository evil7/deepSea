// ---------------------------------------------------------------------------
// RequireAuth —— 登录守卫（deepc-link 互联页专用）
//
// 目标：/links、/link/:nodeId 需要登录才能使用。未登录访问时：
//   1. 生成当前完整位置（pathname + search）作为回跳目标
//   2. 整页跳转 /auth/login?redirect=<当前位置>（⚠️ 必须整页导航）
//   3. Worker 完成 OAuth 后回跳 <redirect>?auth=success
//   4. useAuth 监听 location.search 的 auth=success 刷新用户态 → 守卫放行
//
// 登录后「返回原访问位置」由此天然达成：redirect 即发起访问时所在的页面
// （如 /link/<nodeId> 登录后自动回到该连接页，继续自动连接）。
//
// ⚠️ 为什么不能用 <Navigate>：/auth/* 是 Worker 处理的路由（无对应前端 Route），
//   react-router 的 <Navigate> 是 SPA 客户端跳转，会命中 `*` 兜底渲染首页，
//   而不是真正发起到 Worker 的 GitHub OAuth。故必须 window.location 整页跳转，
//   与 topbar「登录」按钮用 <a href> 真实导航保持一致。
// ---------------------------------------------------------------------------

import type { JSX } from "react"
import { useEffect } from "react"
import { useLocation } from "react-router-dom"

import { useAuth } from "@/hooks/use-auth"
import { loginUrl } from "@/lib/auth"

export function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  // 整页跳转登录（带回当前完整位置作为回跳目标）。
  useEffect(() => {
    if (loading || user) return
    const redirect = `${location.pathname}${location.search}`
    window.location.assign(loginUrl(redirect))
  }, [loading, user, location.pathname, location.search])

  // 未登录 / 加载中：渲染空占位（即将整页跳转登录，避免闪现首页）。
  if (loading || !user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="text-sm text-muted-foreground">正在验证登录态…</span>
      </div>
    )
  }

  return children
}
