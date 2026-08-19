import {
  Compass,
  Layers,
  Loader2,
  LogOut,
  MessagesSquare,
  Package,
  UserCircle,
  Waves,
} from "lucide-react"
import { Link } from "react-router-dom"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/hooks/use-auth"
import { loginUrl } from "@/lib/auth"

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
                  aria-label={`已登录：${user.login}`}
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
                    {user.login}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <p className="text-sm leading-none font-medium">
                    {user.login}
                  </p>
                  {user.email && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {user.email}
                    </p>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => void logout()}
                >
                  <LogOut className="size-4" />
                  登出
                </DropdownMenuItem>
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
