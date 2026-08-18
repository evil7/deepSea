import {
  Compass,
  LogIn,
  MessagesSquare,
  Package,
  Rocket,
  ShieldCheck,
  Waves,
} from "lucide-react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"

const menuItems = [
  // 插件生态走独立路由；其余为首页锚点（回首页滚动定位）
  { label: "插件生态", to: "/plugins", icon: Compass, anchor: false },
  { label: "社区", to: "/#community", icon: MessagesSquare, anchor: true },
  { label: "安装互助", to: "/#install", icon: Rocket, anchor: true },
  { label: "插件管理", to: "/#manage", icon: Package, anchor: true },
  { label: "安全管理", to: "/#security", icon: ShieldCheck, anchor: true },
]

export function Topbar() {
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
          <Button asChild size="sm" className="hidden sm:inline-flex">
            <Link to="/">
              <LogIn className="size-4" />
              登录
            </Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
