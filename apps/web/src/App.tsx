import { useEffect, useState } from "react"
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom"

import { Toaster } from "@/components/ui/sonner"
import { Topbar } from "@/components/layout/topbar"
import type { OceanConf } from "@/components/showcase/ocean-conf"
import { Ocean } from "@/components/showcase/ocean"
import { SeaDebugPanel } from "@/components/showcase/sea-debug-panel"
import type { SeaState } from "@/components/showcase/sea-state"
import { useAuth } from "@/hooks/use-auth"
import { useDiscussionsSync } from "@/hooks/use-discussions-sync"
import { useIsMobile } from "@/hooks/use-mobile"
import { HomePage } from "@/pages/home"
import { PluginDetailPage } from "@/pages/plugin-detail"
import { PluginsPage } from "@/pages/plugins"
import { CommunityPage } from "@/pages/community"
import { CommunityDetailPage } from "@/pages/community-detail"
import { SonarPage } from "@/pages/sonar"
import { DeviceLoginPage } from "@/pages/device-login"

/** 旧路由 /community/:number → 跳转到 /community/dpc/:number（默认社区） */
function CommunityNumberRedirect() {
  const { number } = useParams<{ number: string }>()
  return <Navigate to={`/community/dpc/${number}`} replace />
}

export function App() {
  // 海洋参数配置（调试面板 #sea-debug 调整；也可以直接写 JSON 对象）
  const [conf, setConf] = useState<Partial<OceanConf>>({})
  const location = useLocation()

  // 全局登录态（topbar 用户卡片同源）；登录后由 useDiscussionsSync 启动
  // 前端同步 worker（每 3 分钟刷新 discussions 列表，见 discussions-sync.ts）
  const { user } = useAuth()
  useDiscussionsSync(user)

  // 移动端：不渲染 3D 海洋（WebGL 开销大），改静态渐变背景；调试面板同理
  const isMobile = useIsMobile()

  // 二级功能页（/plugins、/plugin/...）：固定海底 + 背景虚化
  // /auth/* 为登录等纯功能路由（worker 处理），不改变海洋展示状态（视为首页）
  const isAuthRoute = location.pathname.startsWith("/auth/")
  const isSubPage = !isAuthRoute && location.pathname !== "/"

  // 统一海洋状态：surface=海面（首页 hero/插件精选），deep=深海
  // 驱动源（动画路径统一）：
  //   · 路由变化 → 功能页 deep / 回首页 surface
  //   · 首页翻屏（滚动/点击探索更多/进度点）→ 核心能力屏 deep，其余 surface
  const [seaState, setSeaState] = useState<SeaState>(
    isSubPage ? "deep" : "surface"
  )

  // 路由变化 → 同步海洋状态（功能页固定深海；回首页回海面）
  useEffect(() => {
    setSeaState(isSubPage ? "deep" : "surface")
  }, [isSubPage])

  // 首页翻屏上报 → 仅首页路由时采纳（二级页由路由状态锁定）
  const handleHomeSeaState = (state: SeaState) => {
    if (!isSubPage) {
      setSeaState(state)
    }
  }

  // 路由跳转后回到顶部（已取消 hash 定位：首页各屏跳转改由 location.state 承载，
  // 不再依赖 URL hash，避免 hash 与 Swiper transform 定位不一致导致的滚动问题）
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  return (
    <div id="top" className="min-h-dvh">
      {/* 3D 海面背景：仅桌面首页渲染（移动端用静态渐变，见下方）；
          子路由页面使用 shadcn 默认背景，不叠加海洋 3D */}
      {!isSubPage && !isMobile && <Ocean conf={conf} state={seaState} blur={false} />}

      {/* 移动端首页：静态深海渐变背景（替代 3D 海洋，省 WebGL） */}
      {!isSubPage && isMobile && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0"
          style={{
            background:
              "linear-gradient(180deg, #0a1a3a 0%, #0a1730 35%, #071027 65%, #04101f 100%)",
          }}
        />
      )}

      {/* 调试面板：仅桌面首页（地址 #sea-debug 显示，滑块调参 + 复制 JSON） */}
      {!isSubPage && !isMobile && <SeaDebugPanel conf={conf} onChange={setConf} />}

      <Topbar />

      <Routes>
        <Route
          path="/"
          element={
            <HomePage
              seaState={seaState}
              onSeaStateChange={handleHomeSeaState}
            />
          }
        />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/plugin/:owner/:repo" element={<PluginDetailPage />} />
        <Route path="/sonar" element={<SonarPage />} />
        <Route path="/sonar/:nodeId" element={<SonarPage />} />
        <Route path="/device-login" element={<DeviceLoginPage />} />
        <Route path="/community" element={<Navigate to="/community/dpc" replace />} />
        <Route path="/community/dsh" element={<CommunityPage />} />
        <Route path="/community/dpc" element={<CommunityPage />} />
        <Route
          path="/community/dsh/:number"
          element={<CommunityDetailPage />}
        />
        <Route
          path="/community/dpc/:number"
          element={<CommunityDetailPage />}
        />
        <Route
          path="/community/:number"
          element={<CommunityNumberRedirect />}
        />
        <Route
          path="*"
          element={
            <HomePage
              seaState={seaState}
              onSeaStateChange={handleHomeSeaState}
            />
          }
        />
      </Routes>

      {/* 全局提示（自行捕捞需登录等）
           · richColors：开启后 success/info/warning/error 各自醒目配色
             （否则所有类型同色，仅图标不同，告警不醒目）
           · theme="dark"：站点为深色海洋视觉，固定暗色避免浅色系统下白底突兀 */}
      <Toaster position="bottom-right" richColors theme="dark" />
    </div>
  )
}

export default App
