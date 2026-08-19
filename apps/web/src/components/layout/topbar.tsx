import {
  Compass,
  ExternalLink,
  Layers,
  Loader2,
  LogOut,
  MessagesSquare,
  Package,
  RefreshCw,
  UserCircle,
  Waves,
} from "lucide-react"
import { Link } from "react-router-dom"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/hooks/use-auth"
import { loginUrl, reauthUrl } from "@/lib/auth"

const menuItems = [
  // 与首页 view 逐一对应（不做直接进入页面的动作，全部滚动定位）：
  //   · 生态概览 → 首页生态概览屏（#dsh-ecosystem）
  //   · 插件精选 → 首页插件精选屏（#dsh-curated）
  //   · 讨论交流 → 首页讨论交流屏（#dsh-community）
  //   · 深海套装 → 首页深海套装屏（#dsh-deepsea-kit）
  { label: "生态概览", to: "/#dsh-ecosystem", icon: Compass },
  { label: "插件精选", to: "/#dsh-curated", icon: Layers },
  { label: "讨论交流", to: "/#dsh-community", icon: MessagesSquare },
  { label: "深海套装", to: "/#dsh-deepsea-kit", icon: Package },
]

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
  const { user, loading, logout } = useAuth()

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Waves className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">deepSea</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="主导航">
          {menuItems.map((item) => (
            <Button key={item.to} asChild variant="ghost" size="sm">
              <Link to={item.to}>
                <item.icon className="size-4" />
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {loading ? (
            <Button variant="ghost" size="sm" disabled aria-label="加载中">
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
                  aria-label={`已登录：${user.name?.trim() || user.login}`}
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
                  <ProfileStat value={user.followers ?? 0} label="关注者" />
                  <ProfileStat value={user.following ?? 0} label="关注中" />
                  <ProfileStat value={user.public_repos ?? 0} label="公开仓库" />
                </div>

                {/* 底部栏：重新授权 + 登出账号（等宽按钮组） */}
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <Button asChild variant="outline" size="sm" className="flex-1">
                    <a href={reauthUrl()}>
                      <RefreshCw className="size-4" />
                      重新授权
                    </a>
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={() => void logout()}
                  >
                    <LogOut className="size-4" />
                    登出账号
                  </Button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            // 未登录：站内登录入口（Worker /auth/login 生成 state 后 302 GitHub）
            // 必须用 <a href> 真实导航：/auth/login 由 Worker 处理（无前端路由），
            // 若用 react-router <Link> 会命中 SPA 兜底路由、请求到不了 Worker。
            <Button
              asChild
              size="sm"
              variant="outline"
              className="hidden sm:inline-flex"
            >
              <a href={loginUrl()}>
                <UserCircle className="size-4" />
                登录
              </a>
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
