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
import { useTranslation } from "react-i18next"
import { Swiper, SwiperSlide } from "swiper/react"
import { Autoplay } from "swiper/modules"
import "swiper/css"

import { useSlideReveal } from "@/components/showcase/slide-reveal"
import { HOME_SLIDE_IDS } from "@/components/showcase/sea-state"
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
  /** 独立路由目标（如 /plugins） */
  to?: string
  /** 首页 slide 目标（点击回到首页对应屏；取消 hash 定位） */
  slideId?: string
}

export function Features({ active = false }: { active?: boolean }) {
  const { t } = useTranslation()
  // 特性卡（文案随语言切换，组件内生成）
  const features: Feature[] = [
    {
      id: "feature-explore",
      label: t("home.featureSearchLabel"),
      icon: Compass,
      title: t("home.featureSearchTitle"),
      description: t("home.featureSearchDesc"),
      tag: "discovery",
      to: "/plugins",
    },
    {
      id: "feature-curated",
      label: t("home.featureCuratedLabel"),
      icon: Layers,
      title: t("home.featureCuratedTitle"),
      description: t("home.featureCuratedDesc"),
      tag: "curated",
      slideId: HOME_SLIDE_IDS.curated,
    },
    {
      id: "feature-community",
      label: t("home.featureCommunityLabel"),
      icon: MessagesSquare,
      title: t("home.featureCommunityTitle"),
      description: t("home.featureCommunityDesc"),
      tag: "discussions",
      slideId: HOME_SLIDE_IDS.community,
    },
    {
      id: "feature-install",
      label: t("home.featureInstallLabel"),
      icon: Rocket,
      title: t("home.featureInstallTitle"),
      description: t("home.featureInstallDesc"),
      tag: "issue-bridge",
      slideId: HOME_SLIDE_IDS.deepseaKit,
    },
    {
      id: "feature-manage",
      label: t("home.featureManageLabel"),
      icon: Package,
      title: t("home.featureManageTitle"),
      description: t("home.featureManageDesc"),
      tag: "plugin-manager",
      slideId: HOME_SLIDE_IDS.deepseaKit,
    },
    {
      id: "feature-kit",
      label: t("home.featureKitLabel"),
      icon: Palette,
      title: t("home.featureKitTitle"),
      description: t("home.featureKitDesc"),
      tag: "deepsea-kit",
      slideId: HOME_SLIDE_IDS.deepseaKit,
    },
  ]

  // animejs 进入动画：标题区上浮 → 卡片 stagger（进入视口触发）
  const sectionRef = useSlideReveal<HTMLDivElement>()

  return (
    // 父级（FullscreenSlides）已固定每屏视口高度，这里撑满并垂直居中
    // 内容页有半透明深色遮罩（fullscreen-slides contentOverlay），文字用浅色系
    // active（海洋 deep 状态）时卡片上浮淡入 —— 与点击/滚动/路由统一驱动
    <div
      ref={sectionRef}
      className={cn(
        "flex h-full w-full flex-col items-center justify-center px-4 py-10 transition-all duration-700 sm:px-6",
        active ? "translate-y-0 opacity-100" : "translate-y-8 opacity-70"
      )}
    >
      {/* 杂志化标题区：眉题编号 + 居中大标题 */}
      <div className="slide-reveal-title mx-auto mb-10 max-w-2xl text-center">
        <p className="font-mono text-xs tracking-[0.3em] text-cyan-300/90">
          01 · ECOSYSTEM
        </p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-white drop-shadow-[0_1px_6px_rgba(2,8,24,0.9)] sm:text-4xl">
          {t("home.featuresSubtitle")}
        </h2>
        <p className="mt-3 text-white/75">
          {t("home.featuresDesc")}
        </p>
      </div>

      {/* 卡片无限循环轮播：loop 无限循环 + autoplay 丝滑自动滚动（无分页点）。
          响应式每屏张数：移动 1.1 / 平板 2 / 桌面 3；nested 与外层垂直翻页
          Swiper 协同（水平滑动归内层、垂直翻页归外层），互不干扰。
          hover 时暂停自动滚动，避免与用户手动拖动冲突。 */}
      <Swiper
        modules={[Autoplay]}
        slidesPerView={1.1}
        spaceBetween={16}
        loop
        nested
        autoplay={{ delay: 2500, disableOnInteraction: false, pauseOnMouseEnter: true }}
        breakpoints={{
          640: { slidesPerView: 2, spaceBetween: 20 },
          1024: { slidesPerView: 3, spaceBetween: 24 },
        }}
        className="feature-swiper w-full max-w-7xl"
      >
        {features.map((feature) => (
          <SwiperSlide key={feature.id} className="h-auto">
            <Card
              id={feature.id}
              className="slide-reveal-item h-full scroll-mt-24 border-white/15 bg-slate-900/70 text-white backdrop-blur-sm transition-colors hover:border-primary/50"
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
                  <Link
                    to={feature.to ?? "/"}
                    state={
                      feature.slideId ? { slideId: feature.slideId } : undefined
                    }
                  >
                    {feature.label} →
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  )
}
