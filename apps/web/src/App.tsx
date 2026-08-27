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
import { usePageMeta } from "@/hooks/use-page-meta"
import { HomePage } from "@/pages/home"
import { PluginDetailPage } from "@/pages/plugin-detail"
import { PluginsPage } from "@/pages/plugins"
import { CommunityPage } from "@/pages/community"
import { CommunityDetailPage } from "@/pages/community-detail"
import { LinksPage } from "@/pages/links"
import { DeviceLoginPage } from "@/pages/device-login"
import { RequireAuth } from "@/components/auth/require-auth"
import { SiteFooter } from "@/components/layout/site-footer"

/** 旧路由 /community/:number → 跳转到 /community/dpc/:number（默认社区） */
function CommunityNumberRedirect() {
  const { number } = useParams<{ number: string }>()
  return <Navigate to={`/community/dpc/${number}`} replace />
}

const SITE = "https://deepc.cn"

/** 路由 → SEO meta 映射（SPA 路由级 SEO；静态兜底 meta 在 index.html）。
 *  动态参数页（插件 / 帖子）用占位模板，页面内可再调 usePageMeta 覆盖更精确文案。 */
function seoForPath(pathname: string) {
  // 插件详情 /plugin/:owner/:repo
  const pluginMatch = pathname.match(/^\/plugin\/([^/]+)\/([^/]+)\/?$/)
  if (pluginMatch) {
    const [, owner, repo] = pluginMatch
    return {
      title: `${owner}/${repo} · 插件详情 · deepSea`,
      description: `查看 DeepSeek Harness 插件 ${owner}/${repo} 的详情、安装命令与使用说明。`,
      canonical: `${SITE}/plugin/${owner}/${repo}`,
    }
  }
  // 帖子详情 /community/{dpc|dsh}/:number
  const postMatch = pathname.match(/^\/community\/(dpc|dsh)\/(\d+)\/?$/)
  if (postMatch) {
    const [, source, number] = postMatch
    return {
      title: `社区讨论 #${number} · deepSea`,
      description:
        source === "dsh"
          ? "蓝鲸社区（DeepSeek Harness 官方）讨论详情。"
          : "浪尖酒馆（deepSea 自家社区）讨论详情。",
      canonical: `${SITE}/community/${source}/${number}`,
    }
  }
  switch (pathname) {
    case "/":
      return {
        title: "deepSea · DeepSeek Harness 插件生态社区",
        description:
          "发现与搜索 DeepSeek Harness 插件、浏览插件排行榜、参与社区讨论、一站式安装与管理插件。",
        canonical: `${SITE}/`,
      }
    case "/plugins":
      return {
        title: "插件精选 · deepSea",
        description: "浏览 DeepSeek Harness 插件精选与排行榜，一键安装你需要的插件。",
        canonical: `${SITE}/plugins`,
      }
    case "/community":
    case "/community/dpc":
      return {
        title: "浪尖酒馆 · deepSea 社区",
        description: "deepSea 自建社区（浪尖酒馆）：分享插件、提问求助、讨论 DeepSeek Harness 生态。",
        canonical: `${SITE}/community/dpc`,
      }
    case "/community/dsh":
      return {
        title: "蓝鲸社区 · DeepSeek Harness 官方",
        description: "DeepSeek Harness 官方社区（蓝鲸社区）：官方公告、插件展示、Q&A 与想法征集。",
        canonical: `${SITE}/community/dsh`,
      }
    case "/links":
      return {
        title: "多端互联 · deepSea",
        description: "管理 deepSea 多端互联：本地共享、Tunnel 映射与主站纳管。",
        canonical: `${SITE}/links`,
        noindex: true,
      }
    case "/device-login":
      return {
        title: "设备授权登录 · deepSea",
        description: "使用设备授权码登录 deepSea。",
        canonical: `${SITE}/device-login`,
        noindex: true,
      }
    default:
      // /auth/* 等 Worker 路由与未知路径：不收录
      if (pathname.startsWith("/auth/")) {
        return { title: "deepSea", noindex: true }
      }
      return { title: "deepSea · DeepSeek Harness 插件生态社区", canonical: `${SITE}/` }
  }
}

export function App() {
  // 海洋参数配置（调试面板 #sea-debug 调整；也可以直接写 JSON 对象）
  const [conf, setConf] = useState<Partial<OceanConf>>({})
  const location = useLocation()

  // SPA 路由级 SEO：随路径更新 title / description / canonical / robots
  usePageMeta(seoForPath(location.pathname))

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

  // 路由变化 → 同步海洋状态（功能页固定深海；回首页回海面）。
  // 不用 effect 同步 setState（React Compiler 会报级联渲染），
  // 改「渲染期间调整状态」：prev 比较 + 渲染中 setState（React 官方推荐模式，
  // 组件会立即用新状态重渲染，不额外提交一次）。首次渲染 prev===当前值不触发。
  const [prevSubPage, setPrevSubPage] = useState(isSubPage)
  if (prevSubPage !== isSubPage) {
    setPrevSubPage(isSubPage)
    setSeaState(isSubPage ? "deep" : "surface")
  }

  // 首页翻屏上报 → 仅首页路由时采纳（二级页由路由状态锁定）
  const handleHomeSeaState = (state: SeaState) => {
    if (!isSubPage) {
      setSeaState(state)
    }
  }

  // 路由跳转后回到顶部（已取消 hash 定位：首页各屏跳转改由 location.state 承载，
  // 不再依赖 URL hash，避免 hash 与 Swiper transform 定位不一致导致的滚动问题）。
  // pathname 作为触发信号：路由变化即重置滚动位置（scrollTo 目标恒为顶部）。
  useEffect(() => {
    if (location.pathname) {
      window.scrollTo(0, 0)
    }
  }, [location.pathname])

  return (
    <div id="top" className="flex min-h-dvh flex-col">
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

      {/* 内容区：flex-1 撑满（子页面主内容自适应高度，footer 贴底） */}
      <div className="flex min-h-0 flex-1 flex-col">
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
          path="/links"
          element={
            <RequireAuth>
              <LinksPage />
            </RequireAuth>
          }
        />
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
      </div>

      {/* 子页面共享 footer（首页 / 保留其专属三行布局 footer；/auth/* 为 Worker 路由不渲染；
          /link/:nodeId 为沉浸式全屏 chatUI，隐藏 footer 避免挤压） */}
      {isSubPage && <SiteFooter />}

      {/* 全局提示（自行捕捞需登录等）
           · richColors：开启后 success/info/warning/error 各自醒目配色
           · theme 跟随站点主题（浅色/深色切换） */}
      <Toaster position="bottom-right" richColors />
    </div>
  )
}

export default App
