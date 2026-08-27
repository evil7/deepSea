import {
  Compass,
  ExternalLink,
  Globe,
  Layers,
  Loader2,
  LogOut,
  MessagesSquare,
  Moon,
  Package,
  RefreshCw,
  Sun,
  UserCircle,
  Waves,
} from "lucide-react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/components/theme-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/hooks/use-auth"
import { useAuthHrefs } from "@/hooks/use-auth-hrefs"
import { HOME_SLIDE_IDS } from "@/components/showcase/sea-state"

/** 名片统计格（关注者 / 关注中 / 公开仓库） */
function ProfileStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex-1 px-2 py-2.5 text-center">
      <p className="text-sm font-semibold tabular-nums">
        {value.toLocaleString()}
      </p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{label}</p>
    </div>
  )
}

export function Topbar() {
  const { t, i18n } = useTranslation()
  const { user, loading, logout } = useAuth()
  const { loginHref, reauthHref } = useAuthHrefs()
  const { theme, setTheme } = useTheme()

  // 首页各屏菜单（与首页 slide 逐一对应；文案随语言切换）
  const menuItems = [
    { label: t("nav.ecosystem"), slideId: HOME_SLIDE_IDS.ecosystem, icon: Compass },
    { label: t("nav.curated"), slideId: HOME_SLIDE_IDS.curated, icon: Layers },
    { label: t("nav.community"), slideId: HOME_SLIDE_IDS.community, icon: MessagesSquare },
    { label: t("nav.deepseaKit"), slideId: HOME_SLIDE_IDS.deepseaKit, icon: Package },
  ]

  const toggleTheme = () => {
    if (theme === "system") {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches
      setTheme(isDark ? "light" : "dark")
    } else {
      setTheme(theme === "dark" ? "light" : "dark")
    }
  }

  return (
    <header className="sticky top-0 z-50 h-16 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link
          to="/"
          state={{ slideId: "hero" }}
          className="flex items-center gap-2.5"
        >
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Waves className="size-5" />
          </span>
          {/* 站点名称：手机端隐藏，仅保留 logo */}
          <span className="hidden text-lg font-semibold tracking-tight sm:inline">
            deepSea
          </span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label={t("nav.mainNav")}>
          {menuItems.map((item) => (
            <Button key={item.slideId} asChild variant="ghost" size="sm" className="whitespace-nowrap">
              <Link to="/" state={{ slideId: item.slideId }}>
                <item.icon className="size-4" />
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* 语言切换器：紧跟明暗切换按钮（Globe 图标 → zh / EN） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                aria-label={t("nav.switchLanguage")}
                title={t("nav.switchLanguage")}
              >
                <Globe className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8}>
              <button
                type="button"
                onClick={() => void i18n.changeLanguage("zh-CN")}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent ${
                  i18n.language.startsWith("zh")
                    ? "font-semibold text-cyan-300"
                    : "text-foreground"
                }`}
              >
                简体中文
              </button>
              <button
                type="button"
                onClick={() => void i18n.changeLanguage("en-US")}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent ${
                  i18n.language.startsWith("en")
                    ? "font-semibold text-cyan-300"
                    : "text-foreground"
                }`}
              >
                English
              </button>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={theme === "dark" ? t("nav.switchToLight") : t("nav.switchToDark")}
            title={theme === "dark" ? t("nav.switchToLight") : t("nav.switchToDark")}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </Button>
          {loading ? (
            <Button variant="ghost" size="sm" disabled aria-label={t("nav.loading")}>
              <Loader2 className="size-4 animate-spin" />
            </Button>
          ) : user ? (
            // 已登录：用户卡片 → 点击展开下拉菜单
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex items-center gap-2 px-1.5 hover:bg-accent/60"
                  aria-label={t("nav.loggedInAs", {
                    name: user.name?.trim() || user.login,
                  })}
                >
                  <Avatar className="size-7 border border-border/60">
                    <AvatarImage
                      src={user.avatar_url}
                      alt={user.login}
                      referrerPolicy="no-referrer"
                    />
                    <AvatarFallback className="text-[10px]">
                      {user.login.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-28 truncate text-sm sm:inline">
                    {user.name?.trim() || user.login}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="w-72 p-0 overflow-hidden"
              >
                {/* 名片头部：头像 + 姓名 + 主页链接 + 简介 */}
                <div className="relative bg-linear-to-br from-primary/12 via-transparent to-transparent px-4 pt-4 pb-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="size-14 shrink-0 border border-border/60 shadow-sm">
                      <AvatarImage
                        src={user.avatar_url}
                        alt={user.login}
                        referrerPolicy="no-referrer"
                      />
                      <AvatarFallback className="text-lg">
                        {user.login.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold tracking-tight">
                        {user.name?.trim() || user.login}
                      </p>
                      <a
                        href={user.html_url || `https://github.com/${user.login}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <span className="truncate">@{user.login}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    </div>
                  </div>
                  {user.bio?.trim() && (
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      {user.bio.trim()}
                    </p>
                  )}
                </div>

                {/* 统计条 */}
                <div className="flex divide-x divide-border/60 border-y border-border/60 bg-muted/30">
                  <ProfileStat value={user.followers ?? 0} label={t("nav.followers")} />
                  <ProfileStat value={user.following ?? 0} label={t("nav.following")} />
                  <ProfileStat value={user.public_repos ?? 0} label={t("nav.publicRepos")} />
                </div>

                {/* 底部栏：重新授权 + 登出账号（等宽按钮组） */}
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <Button asChild variant="outline" size="sm" className="flex-1">
                    <a href={reauthHref}>
                      <RefreshCw className="size-4" />
                      {t("nav.reauth")}
                    </a>
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={() => void logout()}
                  >
                    <LogOut className="size-4" />
                    {t("nav.logoutAccount")}
                  </Button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            // 未登录：站内登录入口（Worker /auth/login 生成 state 后 302 GitHub）
            // 必须用 <a href> 真实导航：/auth/login 由 Worker 处理（无前端路由），
            // 若用 react-router <Link> 会命中 SPA 兜底路由、请求到不了 Worker。
            <>
              {/* 手机端：icon-only 方块（与 logo size-9 同等大小） */}
              <Button
                asChild
                size="icon"
                variant="outline"
                className="size-9 sm:hidden"
                aria-label={t("common.login")}
              >
                <a href={loginHref}>
                  <UserCircle className="size-5" />
                </a>
              </Button>
              {/* 桌面端：带文字按钮 */}
              <Button
                asChild
                size="sm"
                variant="outline"
                className="hidden sm:inline-flex"
              >
                <a href={loginHref}>
                  <UserCircle className="size-4" />
                  {t("common.login")}
                </a>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
