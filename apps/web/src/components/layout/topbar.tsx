import {
  Compass,
  LogIn,
  MessagesSquare,
  Package,
  Rocket,
  ShieldCheck,
  Waves,
} from "lucide-react"

import { Button } from "@/components/ui/button"

const menuItems = [
  { label: "插件生态", href: "#explore", icon: Compass },
  { label: "社区", href: "#community", icon: MessagesSquare },
  { label: "安装互助", href: "#install", icon: Rocket },
  { label: "插件管理", href: "#manage", icon: Package },
  { label: "安全管理", href: "#security", icon: ShieldCheck },
]

export function Topbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Waves className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">deepSea</span>
        </a>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="主导航">
          {menuItems.map((item) => (
            <Button key={item.href} asChild variant="ghost" size="sm">
              <a href={item.href}>
                <item.icon className="size-4" />
                {item.label}
              </a>
            </Button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild size="sm" className="hidden sm:inline-flex">
            <a href="#top">
              <LogIn className="size-4" />
              登录
            </a>
          </Button>
        </div>
      </div>
    </header>
  )
}
