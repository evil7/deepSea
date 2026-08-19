import {
  Compass,
  Layers,
  MessagesSquare,
  Package,
  Palette,
  Rocket,
  type LucideIcon,
} from "lucide-react"
import { Link } from "react-router-dom"

import { useSlideReveal } from "@/components/showcase/slide-reveal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

type Feature = {
  id: string
  label: string
  icon: LucideIcon
  title: string
  description: string
  tag?: string
  /** 跳转目标：路由（/plugins）或首页锚点（/#xxx） */
  to: string
}

const features: Feature[] = [
  {
    id: "feature-explore",
    label: "搜索插件",
    icon: Compass,
    title: "全生态插件搜罗",
    description:
      "对全 GitHub 的 dsh topics 与关键词持续搜索，聚合所有周边插件仓库、star 与更新动态。",
    tag: "discovery",
    to: "/plugins",
  },
  {
    id: "feature-curated",
    label: "查看精选",
    icon: Layers,
    title: "热门与最新精选",
    description:
      "深海里打捞上来的生态亮点：封面流画廊一览热门与最新插件，直达详情。",
    tag: "curated",
    to: "/#dsh-curated",
  },
  {
    id: "feature-community",
    label: "进入酒馆",
    icon: MessagesSquare,
    title: "双社区讨论交流",
    description:
      "官方社区只读直连 + 自家可互动社区，撕纸对比、最热与最新一目了然。",
    tag: "discussions",
    to: "/#dsh-community",
  },
  {
    id: "feature-install",
    label: "安装指引",
    icon: Rocket,
    title: "安装即用，有问直达",
    description:
      "统一生成安装指引，一键直达对应仓库 issues 发起提问与工单。",
    tag: "issue-bridge",
    to: "/#dsh-deepsea-kit",
  },
  {
    id: "feature-manage",
    label: "管理插件",
    icon: Package,
    title: "线上线下集中管理",
    description:
      "deepc 本地集中管理多 profile 插件：清单、版本、更新提示一站式。",
    tag: "plugin-manager",
    to: "/#dsh-deepsea-kit",
  },
  {
    id: "feature-kit",
    label: "了解套装",
    icon: Palette,
    title: "主题 · 互联 · 安全",
    description:
      "主题快速构造、多端 WebRTC 互联与安全护栏，把 deepSea 装进口袋一套带走。",
    tag: "deepsea-kit",
    to: "/#dsh-deepsea-kit",
  },
]

export function Features({ active = false }: { active?: boolean }) {
  // animejs 进入动画：标题区上浮 → 卡片 stagger（进入视口触发）
  const sectionRef = useSlideReveal<HTMLDivElement>()

  return (
    // 父级（FullscreenSlides）已固定每屏视口高度，这里撑满并垂直居中
    // 内容页有半透明深色遮罩（fullscreen-slides contentOverlay），文字用浅色系
    // active（海洋 deep 状态）时卡片上浮淡入 —— 与点击/滚动/路由统一驱动
    <div
      ref={sectionRef}
      className={cn(
        "flex h-full w-full flex-col items-center justify-center px-4 py-16 transition-all duration-700 sm:px-6",
        active ? "translate-y-0 opacity-100" : "translate-y-8 opacity-70"
      )}
    >
      {/* 杂志化标题区：眉题编号 + 居中大标题 */}
      <div className="slide-reveal-title mx-auto mb-12 max-w-2xl text-center">
        <p className="font-mono text-xs tracking-[0.3em] text-cyan-300/90">
          02 · ECOSYSTEM
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white drop-shadow-[0_1px_6px_rgba(2,8,24,0.9)] sm:text-4xl">
          万物皆插件，经此入海流
        </h2>
        <p className="mt-3 text-white/75">
          DeepSeek Harness 插件生态的入海口——从发现、精选、社区到安装、
          管理与互联，六大能力聚合。
        </p>
      </div>

      <div className="grid w-full max-w-7xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <Card
            key={feature.id}
            id={feature.id}
            className="slide-reveal-item scroll-mt-24 border-white/15 bg-slate-900/70 text-white backdrop-blur-sm transition-colors hover:border-primary/50"
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <feature.icon className="size-5" />
                </span>
                {feature.tag && (
                  <Badge
                    variant="secondary"
                    className="border-white/10 bg-white/10 font-mono text-white/80"
                  >
                    {feature.tag}
                  </Badge>
                )}
              </div>
              <CardTitle className="mt-4 text-white">{feature.title}</CardTitle>
              <CardDescription className="text-white/65">
                {feature.description}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="px-0 text-white/80 hover:text-white"
              >
                <Link to={feature.to}>{feature.label} →</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
