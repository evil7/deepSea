import { useEffect, useState } from "react"
import { Routes, Route, useLocation } from "react-router-dom"

import { Toaster } from "@/components/ui/sonner"
import { Topbar } from "@/components/layout/topbar"
import type { OceanConf } from "@/components/showcase/ocean-conf"
import { Ocean } from "@/components/showcase/ocean"
import { SeaDebugPanel } from "@/components/showcase/sea-debug-panel"
import type { SeaState } from "@/components/showcase/sea-state"
import { HomePage } from "@/pages/home"
import { PluginDetailPage } from "@/pages/plugin-detail"
import { PluginsPage } from "@/pages/plugins"

export function App() {
  // 海洋参数配置（调试面板 #sea-debug 调整；也可以直接写 JSON 对象）
  const [conf, setConf] = useState<Partial<OceanConf>>({})
  const location = useLocation()

  // 二级功能页（/plugins、/plugin/...）：固定海底 + 背景虚化
  const isSubPage = location.pathname !== "/"

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

  // 路由跳转后回到顶部（#hash 锚点除外：首页锚点滚动到对应区块）
  useEffect(() => {
    if (location.hash) {
      const el = document.getElementById(location.hash.slice(1))
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" })
        return
      }
    }
    window.scrollTo(0, 0)
  }, [location.pathname, location.hash])

  return (
    <div id="top" className="min-h-dvh">
      {/* 3D 海面背景：统一海洋状态驱动下潜/上浮动画；二级页叠加 20% 虚化 */}
      <Ocean conf={conf} state={seaState} blur={isSubPage} />

      {/* 调试面板：地址 #sea-debug 显示，滑块调参 + 复制 JSON */}
      <SeaDebugPanel conf={conf} onChange={setConf} />

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

      {/* 全局提示（自行捕捞需登录等） */}
      <Toaster position="bottom-right" />
    </div>
  )
}

export default App
