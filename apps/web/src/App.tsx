import { useEffect, useMemo, useState } from "react"
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { Toaster } from "@/components/ui/sonner"
import { Topbar } from "@/components/layout/topbar"
import { Ocean } from "@/components/showcase/ocean"
import type { SeaState } from "@/components/showcase/sea-state"
import { useAuth } from "@/hooks/use-auth"
import { useDiscussionsSync } from "@/hooks/use-discussions-sync"
import { useUserPreferences } from "@/hooks/use-user-preferences"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePageMeta } from "@/hooks/use-page-meta"
import { HomePage } from "@/pages/home"
import { PluginDetailPage } from "@/pages/plugin-detail"
import { PluginsPage } from "@/pages/plugins"
import { CommunityPage } from "@/pages/community"
import { CommunityDetailPage } from "@/pages/community-detail"
import { LinksPage } from "@/pages/links"
import { DeviceLoginPage } from "@/pages/device-login"
import { SettingsPage } from "@/pages/settings"
import { RequireAuth } from "@/components/auth/require-auth"
import { SiteFooter } from "@/components/layout/site-footer"
import { StarFollowGuide } from "@/components/community/star-follow-guide"

/** 旧路由 /community/:number → 跳转到 /community/dpc/:number（默认社区） */
function CommunityNumberRedirect() {
  const { number } = useParams<{ number: string }>()
  return <Navigate to={`/community/dpc/${number}`} replace />
}

const SITE = "https://deepc.cn"

/** SEO 翻译函数签名（key 为 i18n key，可带插值参数） */
type SeoT = (key: string, options?: Record<string, unknown>) => string

/** 路由 → SEO meta 映射（SPA 路由级 SEO；静态兜底 meta 在 index.html）。
 *  动态参数页（插件 / 帖子）用占位模板，页面内可再调 usePageMeta 覆盖更精确文案。 */
function seoForPath(pathname: string, t: SeoT) {
  // 插件详情 /plugin/:owner/:repo
  const pluginMatch = pathname.match(/^\/plugin\/([^/]+)\/([^/]+)\/?$/)
  if (pluginMatch) {
    const [, owner, repo] = pluginMatch
    return {
      title: t("seo.pluginDetailTitle", { owner, repo }),
      description: t("seo.pluginDetailDesc", { owner, repo }),
      canonical: `${SITE}/plugin/${owner}/${repo}`,
    }
  }
  // 帖子详情 /community/{dpc|dsh}/:number
  const postMatch = pathname.match(/^\/community\/(dpc|dsh)\/(\d+)\/?$/)
  if (postMatch) {
    const [, source, number] = postMatch
    return {
      title: t("seo.postTitle", { number }),
      description:
        source === "dsh" ? t("seo.postDshDesc") : t("seo.postDpcDesc"),
      canonical: `${SITE}/community/${source}/${number}`,
    }
  }
  switch (pathname) {
    case "/":
      return {
        title: t("seo.homeTitle"),
        description: t("seo.homeDesc"),
        canonical: `${SITE}/`,
      }
    case "/plugins":
      return {
        title: t("seo.pluginsTitle"),
        description: t("seo.pluginsDesc"),
        canonical: `${SITE}/plugins`,
      }
    case "/community":
    case "/community/dpc":
      return {
        title: t("seo.dpcTitle"),
        description: t("seo.dpcDesc"),
        canonical: `${SITE}/community/dpc`,
      }
    case "/community/dsh":
      return {
        title: t("seo.dshTitle"),
        description: t("seo.dshDesc"),
        canonical: `${SITE}/community/dsh`,
      }
    case "/links":
      return {
        title: t("seo.linksTitle"),
        description: t("seo.linksDesc"),
        canonical: `${SITE}/links`,
        noindex: true,
      }
    case "/device-login":
      return {
        title: t("seo.deviceTitle"),
        description: t("seo.deviceDesc"),
        canonical: `${SITE}/device-login`,
        noindex: true,
      }
    case "/settings":
      return {
        title: t("seo.settingsTitle"),
        description: t("seo.settingsDesc"),
        canonical: `${SITE}/settings`,
        noindex: true,
      }
    default:
      // /auth/* 等 Worker 路由与未知路径：不收录
      if (pathname.startsWith("/auth/")) {
        return { title: t("seo.authTitle"), noindex: true }
      }
      return { title: t("seo.defaultTitle"), canonical: `${SITE}/` }
  }
}

export function App() {
  const { t } = useTranslation()
  const location = useLocation()

  // SPA 路由级 SEO：随路径更新 title / description / canonical / robots；
  // 语言切换时重算（useTranslation 的 t 引用随语言变化 → 进依赖即触发重算）
  const meta = useMemo(
    () =>
      seoForPath(location.pathname, (key, options) =>
        String(t(key as never, options as never))
      ),
    [location.pathname, t]
  )
  usePageMeta(meta)

  // 全局登录态（topbar 用户卡片同源）；登录后由 useDiscussionsSync 启动
  // 前端同步 worker（每 3 分钟刷新 discussions 列表，见 discussions-sync.ts）
  const { user } = useAuth()
  useDiscussionsSync(user)
  // 用户偏好：登录后从 D1 同步语言/主题/社区屏蔽（写入 localStorage 缓存）；
  // 挂载于全局以便任何页面登录后都能应用账号级偏好
  useUserPreferences()

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
      {!isSubPage && !isMobile && <Ocean state={seaState} blur={false} />}

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
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
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

      {/* 子页面共享 footer（首页 / 保留其专属三行布局 footer；/auth/* 为 Worker 路由不渲染） */}
      {isSubPage && <SiteFooter />}

      {/* star/follow 引导卡片（左下角）：已登录 + 有纳管节点 + 未 star/follow 时展示
          默认参数 evil7/deepSea + evil7/deepwn，props 可覆盖 */}
      <StarFollowGuide star="evil7/deepSea" follow={["evil7", "deepwn"]} />

      {/* 全局提示（自行捕捞需登录等）
           · richColors：开启后 success/info/warning/error 各自醒目配色
           · theme 跟随站点主题（浅色/深色切换） */}
      <Toaster position="bottom-right" richColors />
    </div>
  )
}

export default App
