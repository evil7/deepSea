// ---------------------------------------------------------------------------
// /device-login —— 设备授权确认页（deepc-link Device Grant 流）
//
// 注意：本页路径不能用 /auth/* 前缀——vite dev 会把 /auth 代理到 worker，而 worker
// 没有该前端路由，会回退到 ASSETS（dist 构建产物）。故用 /device-login 独立命名。
// 插件端（127.0.0.1:3080）点「登录」→ 生成 state → 打开本页 ?state=xxx。
// 本页流程：
//   · 未登录 → 提示「请先登录」，跳转 GitHub OAuth（回跳回本页）
//   · 已登录 → 自动 POST /auth/device-grant（传递凭据，无需手动确认）
//   · 授权成功 → 展示成功提示（插件端轮询 poll 自动换取 device_token）
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CheckCircle2, Loader2, LogIn, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/hooks/use-auth"
import { loginUrl } from "@/lib/auth"

type Phase = "idle" | "submitting" | "done" | "error"

export function DeviceLoginPage() {
  const { user, loading } = useAuth()
  const [searchParams] = useSearchParams()
  const state = useMemo(() => searchParams.get("state") ?? "", [searchParams])

  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState<string | null>(null)

  const confirm = useCallback(async () => {
    if (!state || !user) return
    setPhase("submitting")
    setError(null)
    try {
      const res = await fetch("/auth/device-grant", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      })
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean
        error?: string
      } | null
      if (res.ok && body?.ok === true) {
        setPhase("done")
      } else {
        setPhase("error")
        setError("授权失败，请返回插件端重新发起")
      }
    } catch {
      setPhase("error")
      setError("网络错误，请稍后重试")
    }
  }, [state, user])

  // 已登录且有 state → 自动走授权（传递凭据，无需手动点「确认授权」）。
  // 覆盖两条路径：① 主站本就登录着打开本页；② 未登录 → OAuth 回跳后 user 就绪。
  const autoConfirmedRef = useRef(false)
  useEffect(() => {
    if (user && state && !autoConfirmedRef.current) {
      autoConfirmedRef.current = true
      void confirm()
    }
  }, [user, state, confirm])

  // 未登录：引导登录（回跳回本页）。
  const loginHref = useMemo(() => {
    const redirect = `/device-login?state=${encodeURIComponent(state)}`
    return loginUrl(redirect)
  }, [state])

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col items-center justify-center px-4 py-16">
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="flex items-center justify-center gap-2">
            <ShieldCheck className="size-5 text-sky-400" />
            设备授权
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              检查登录状态…
            </div>
          ) : !user ? (
            <>
              <p className="text-sm text-muted-foreground">
                需要登录 GitHub 账号后，才能授权本机 dsh 插件接入你的多端互联。
              </p>
              <Button asChild className="w-full gap-2">
                <a href={loginHref}>
                  <LogIn className="size-4" />
                  登录 GitHub
                </a>
              </Button>
            </>
          ) : phase === "done" ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle2 className="size-10 text-emerald-400" />
              <p className="text-sm font-medium">
                授权成功，请返回 dsh 插件端
              </p>
              <p className="text-xs text-muted-foreground">
                插件端会自动换取设备凭证并完成登录
              </p>
            </div>
          ) : phase === "error" ? (
            <>
              <p className="text-sm text-rose-400">{error ?? "授权失败"}</p>
              <Button onClick={confirm} className="w-full gap-2">
                <ShieldCheck className="size-4" />
                重新授权
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                正在为账号{" "}
                <span className="font-medium text-foreground">{user.login}</span>{" "}
                授权本机 dsh 插件（deepc-link）接入多端互联…
              </p>
              <div className="flex items-center justify-center gap-2 py-2 text-sm text-sky-400">
                <Loader2 className="size-4 animate-spin" />
                {phase === "submitting" ? "授权中…" : "准备授权…"}
              </div>
              {!state && (
                <p className="text-xs text-amber-400">
                  缺少 state 参数，请从插件端重新发起登录
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

export default DeviceLoginPage
