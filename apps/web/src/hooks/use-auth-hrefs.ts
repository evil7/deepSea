// ---------------------------------------------------------------------------
// useAuthHrefs —— 登录/重新授权链路统一「回跳原位置」辅助 hook。
//
// 背景：主站有多处入口需要 / 可触发登录：
//   · 守卫页（/links /link/:nodeId）：RequireAuth 未登录跳 /auth/login?redirect=...
//   · 顶部导航「登录 / 重新授权」：用户手动触发，登录后应回到「发起时的页面」
//   · 社区页回复/评论登录：登录后回到该 community 详情页
//   · device-login：登录后回到授权页继续
//
// 单一职责：返回「当前页面完整位置」（pathname + search）作为 redirect，并派生
// 站内登录 / 重新授权 href。各处复用，避免手动拼 redirect 遗漏 query 参数
// （如 /link/:nodeId 或 /device-login?state=xxx 也要完整带回）。
// ---------------------------------------------------------------------------

import { useLocation } from "react-router-dom"

import { loginUrl, reauthUrl } from "@/lib/auth"

export function useAuthHrefs() {
  const location = useLocation()
  const redirect = `${location.pathname}${location.search}`

  return {
    /** 当前完整位置（pathname + search），作 login/reauth 回跳目标。 */
    redirect,
    /** 站内登录入口 href（登录后回当前页）。 */
    loginHref: loginUrl(redirect),
    /** 强制重新授权入口 href（更新 scope 后回当前页）。 */
    reauthHref: reauthUrl(redirect),
  }
}
