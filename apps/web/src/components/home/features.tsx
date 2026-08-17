import {
  Compass,
  MessagesSquare,
  Package,
  Rocket,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

type Feature = {
  id: string
  label: string
  icon: LucideIcon
  title: string
  description: string
  tag?: string
}

const features: Feature[] = [
  {
    id: "explore",
    label: "插件生态",
    icon: Compass,
    title: "汇聚全生态插件动态",
    description:
      "对全 GitHub 的 dsh 相关 topics 与关键词持续搜索，聚合所有周边插件仓库、star 与更新动态，一站式发现新玩具。",
    tag: "dsh-plugin-discovery",
  },
  {
    id: "community",
    label: "社区",
    icon: MessagesSquare,
    title: "更顺滑的官方社区",
    description:
      "基于官方 discussions 包装出更好的分区、更快的访问与更沉浸的视觉体验，讨论热度与分类一目了然。",
    tag: "dsh-discussions-hub",
  },
  {
    id: "install",
    label: "安装互助",
    icon: Rocket,
    title: "安装即用，有问直达",
    description:
      "统一界面生成安装指引，直连对应插件的 issues 发起提问与工单，互助体验高效直接。",
    tag: "dsh-issue-bridge",
  },
  {
    id: "manage",
    label: "插件管理",
    icon: Package,
    title: "本地可复刻的管理中心",
    description:
      "插件安装、更新提示一站式管理；deepc 插件可复刻本站点，完全用于本地使用。",
    tag: "deepc",
  },
  {
    id: "security",
    label: "安全管理",
    icon: ShieldCheck,
    title: "deepc 安全护栏",
    description:
      "统一且安全的映射方案、动态安全路径与二次验证，为 deepseek-harness 装上安全护栏。",
    tag: "deepc-security",
  },
]

export function Features() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight">
          万物皆可插件，深海皆可探索
        </h2>
        <p className="mt-3 text-muted-foreground">
          围绕 DeepSeek Harness
          打造的五大能力，从发现、社区到安装与安全，一条龙覆盖。
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <Card
            key={feature.id}
            id={feature.id}
            className="scroll-mt-24 transition-colors hover:border-primary/50"
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <feature.icon className="size-5" />
                </span>
                {feature.tag && (
                  <Badge variant="secondary" className="font-mono">
                    {feature.tag}
                  </Badge>
                )}
              </div>
              <CardTitle className="mt-4">{feature.title}</CardTitle>
              <CardDescription>{feature.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="ghost" size="sm" className="px-0">
                <a href={`#${feature.id}`}>{feature.label} →</a>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}
