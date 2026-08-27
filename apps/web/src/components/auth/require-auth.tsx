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
//
// 🔄 循环防护：cookie 存在但实际失效时，/auth/login 可能 302 回跳本页
//   （旧实现：短路分支把「无法解密」降级为有效回跳），导致「跳 login → 回跳
//   → 跳 login」死循环、页面一直刷新。这里用 sessionStorage 记录上次自动跳转
//   时间，短时间（8s）内再次触发则判定循环：停止自动跳转，改为展示明确的
//   「登录已失效」错误态 + 手动重新登录入口（点击时清除 guard 再跳转）。
// ---------------------------------------------------------------------------

import type { JSX } from "react"
import { useEffect, useState } from "react"
import { useLocation } from "react-router-dom"

import { useAuth } from "@/hooks/use-auth"
import { loginUrl } from "@/lib/auth"
import { Button } from "@/components/ui/button"

/** sessionStorage 键：上次自动跳转登录的时间戳（整页跳转间跨挂载保留）。 */
const REDIRECT_GUARD_KEY = "deepsea:login-redirect-guard"
/** 两次自动跳转间隔小于该值 → 判定为 302 循环 */
const REDIRECT_LOOP_MS = 8000

function readGuardTimestamp(): number | null {
  try {
    const raw = sessionStorage.getItem(REDIRECT_GUARD_KEY)
    return raw ? Number(raw) : null
  } catch {
    return null
  }
}

/** 构造回跳目标：pathname + search，剥离 auth 参数。
 * 否则 /links?auth=success（续期后粘滞）会拼成 redirect=/links?auth=success，
 * login/callback 虽能处理，但回跳时 URL 冗余。剥离后回跳干净的原位置。 */
function buildRedirect(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  params.delete("auth")
  const qs = params.toString()
  return `${pathname}${qs ? `?${qs}` : ""}`
}

export function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  // 登录循环错误态：停止自动跳转，提示用户手动重新登录
  const [loopBlocked, setLoopBlocked] = useState(false)

  // 自动跳转登录（带回当前完整位置作为回跳目标）。
  useEffect(() => {
    if (loading || user || loopBlocked) return

    // 循环检测：本次自动跳转与上次间隔过短 → 上一次跳转被 302 打了回来，
    // 说明服务端无法自愈，停止自动跳转避免无限刷新。
    const now = Date.now()
    const last = readGuardTimestamp()
    if (last !== null && now - last < REDIRECT_LOOP_MS) {
      setLoopBlocked(true)
      return
    }
    try {
      sessionStorage.setItem(REDIRECT_GUARD_KEY, String(now))
    } catch {
      /* ignore */
    }
    window.location.assign(loginUrl(buildRedirect(location.pathname, location.search)))
  }, [loading, user, loopBlocked, location.pathname, location.search])

  // 手动重新登录：清除循环 guard 后再整页跳转，允许重新走一次授权。
  const handleManualLogin = () => {
    try {
      sessionStorage.removeItem(REDIRECT_GUARD_KEY)
    } catch {
      /* ignore */
    }
    window.location.assign(loginUrl(buildRedirect(location.pathname, location.search)))
  }

  // 未登录 / 加载中：渲染空占位（即将整页跳转登录，避免闪现首页）。
  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="text-sm text-muted-foreground">正在验证登录态…</span>
      </div>
    )
  }

  if (!user) {
    // 检测到登录循环：展示错误态 + 手动入口，而非无限刷新。
    if (loopBlocked) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-muted-foreground">
            登录状态已失效，自动跳转登录未成功。请点击下方按钮重新登录。
          </p>
          <Button onClick={handleManualLogin}>重新登录</Button>
        </div>
      )
    }
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="text-sm text-muted-foreground">正在验证登录态…</span>
      </div>
    )
  }

  return children
}
