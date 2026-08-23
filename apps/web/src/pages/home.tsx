import { useEffect, useRef, useState } from "react"
import {
  ChevronDown,
  Package,
  Radio,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { ComingSoonSlide } from "@/components/home/coming-soon"
import { CommunitySlide } from "@/components/home/community-slide"
import { Features } from "@/components/home/features"
import { InstallCommand } from "@/components/home/install-command"
import { SiteFooter } from "@/components/layout/site-footer"
import { PluginPreview } from "@/components/plugins/plugin-preview"
import {
  FullscreenSlides,
  type FullscreenSlidesHandle,
} from "@/components/layout/fullscreen-slides"
import {
  DEEP_SLIDE_INDEX,
  type SeaState,
} from "@/components/showcase/sea-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

interface HomePageProps {
  /** 当前海洋状态（由 App 统一管理：路由 + 首页翻屏共同驱动） */
  seaState: SeaState
  /** 首页翻屏/滚动 → 上报海洋状态（App 仅在首页路由时采纳） */
  onSeaStateChange: (state: SeaState) => void
}

/** 首页 slide id → 索引映射（桌面端固定顺序：hero=0, ecosystem=1, ...）。
 *  取消 hash 定位后，站内菜单/卡片跳转经 location.state 携带 slideId 精准定位。 */
const SLIDE_INDEX_BY_ID: Record<string, number> = {
  hero: 0,
  "dsh-ecosystem": 1,
  "dsh-curated": 2,
  "dsh-community": 3,
  "dsh-deepsea-kit": 4,
}

export function HomePage({ seaState, onSeaStateChange }: HomePageProps) {
  const isMobile = useIsMobile()
  const location = useLocation()
  const navigate = useNavigate()
  // 全屏幻灯控制句柄（「探索更多」等入口统一走幻灯跳转）
  const slidesRef = useRef<FullscreenSlidesHandle>(null)
  // 当前屏索引：驱动「探索更多」按钮显隐（仅首页显示，翻屏后隐藏）
  const [activeIndex, setActiveIndex] = useState(0)

  // 翻屏（滚轮/键盘/进度点/探索更多）→ 统一上报海洋状态：
  // 进入第二屏（index ≥ 1）即深海，回到第一屏（index = 0）即海面 —— 由屏切换触发，非高度判断
  const handleSlideChange = (index: number) => {
    setActiveIndex(index)
    onSeaStateChange(index >= DEEP_SLIDE_INDEX ? "deep" : "surface")
  }

  // 站内菜单/卡片跳转到指定屏（消费 location.state.slideId）：
  // 取消 hash 定位后，Topbar 菜单与 Features 卡片经 state 携带 slideId，
  // 这里精准 goTo 对应屏，随后清除 state 避免刷新/重复触发时重复滚动。
  useEffect(() => {
    const slideId = (location.state as { slideId?: string } | null)?.slideId
    if (!slideId) return
    const index = SLIDE_INDEX_BY_ID[slideId]
    if (index != null) {
      slidesRef.current?.goTo(index)
    }
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, navigate, location.pathname])

  // 首屏 hero（带大标题）：手机端不显示安装命令，桌面端保留
  const heroSlide = {
    id: "hero",
    label: "首页",
    node: (
      <div className="relative h-full">
        {/* 内容居中于 hero 屏：slide 占满 content 区（navbar 与 footer 之间），
            相对 slide 垂直居中即可，无需再按视口补偿导航占位 */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center sm:px-6">
          <Badge
            variant="outline"
            className="border-white/20 bg-white/10 text-white backdrop-blur-sm"
          >
            DeepSeek + DeePwn =
          </Badge>
          <h1 className="mt-6 text-5xl font-bold tracking-tight text-white drop-shadow-[0_2px_16px_rgba(8,26,61,0.9)] sm:text-7xl">
            deepSea
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-white/85 drop-shadow-[0_1px_8px_rgba(8,26,61,0.9)] sm:text-lg">
            DeepSeek Harness 插件生态的入海口
            <br />
            发现 · 安装 · 管理 · 互联，一站式聚合
          </p>
          {/* deepc 安装命令：终端风格（仅桌面显示，手机端不显示） */}
          {!isMobile && <InstallCommand />}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              asChild
              size="lg"
              className="border-primary/40 bg-primary/15 text-white hover:bg-primary/30 hover:text-white"
            >
              <Link to="/links">
                <Radio className="size-4" />
                深海互联
              </Link>
            </Button>
          </div>
        </div>
      </div>
    ),
  }

  // 手机端：仅首屏 hero（不渲染后续 showcase 屏）；桌面端：完整多屏
  const slides = isMobile
    ? [heroSlide]
    : [
      heroSlide,
      {
        // 万物皆插件：原第三屏（核心能力）上移到第二屏；轻雾遮罩
        id: "dsh-ecosystem",
        label: "万物皆插件",
        overlayClassName: "bg-slate-950/40 backdrop-blur-[2px]",
        node: <Features active={seaState === "deep"} />,
      },
      {
        // 插件精选：原第二屏移到第三屏；中雾遮罩
        id: "dsh-curated",
        label: "插件精选",
        overlayClassName: "bg-slate-950/55 backdrop-blur-md",
        node: <PluginPreview />,
      },
      {
        // 讨论交流：官方 discussions 最热/最新帖子（GraphQL 抓取）；深雾遮罩
        id: "dsh-community",
        label: "讨论交流",
        overlayClassName: "bg-slate-950/65 backdrop-blur-md",
        node: <CommunitySlide />,
      },
      {
        // 深海套装：占位（后续提供 deepsea 主题/插件管理/多端互联）；浓雾遮罩
        id: "dsh-deepsea-kit",
        label: "深海套装",
        overlayClassName: "bg-slate-950/75 backdrop-blur-lg",
        node: (
          <ComingSoonSlide
            eyebrow="05 · DEEPSEA KIT"
            title="深海套装"
            description="把 deepSea 装进口袋：一套 deepc-link 组合包，搞定远程控制、工程同步与插件管理。"
            items={[
              {
                id: "link",
                icon: Radio,
                title: "操作互联",
                description:
                  "deepc 主站自实现 chatUI，经 deepc-link 加密 RTC 通道远程控制本机 dsh，零端口暴露、零复刻官方前端。",
                tag: "link",
                href: "/links",
              },
              {
                id: "sync",
                icon: RefreshCw,
                title: "工程同步",
                description:
                  "登录后把本地工作区 + 聊天记录经同一加密 RTC 通道实时传输，多端数据一致、备份与迁移。",
                tag: "sync",
              },
              {
                id: "manage",
                icon: Package,
                title: "插件管理",
                description:
                  "本地管理点注入 dsh 设置页，异步执行安装/卸载/更新与安全审计，插件与主题共用一个设置页，多 profile 一站式管理。",
                tag: "deepc",
              },
              {
                id: "security",
                icon: ShieldCheck,
                title: "安全护栏",
                description:
                  "沙箱命名空间映射白名单、动态安全路径、危险操作二次验证与审计日志，同步密钥自协商派生不出设备。",
                tag: "security",
              },
            ]}
          />
        ),
      },
    ]

  return (
    <>
      {/* 沉入海底的入口：fixed 首页底部；仅首页屏显示、翻屏后隐藏（仅桌面显示） */}
      {!isMobile && (
        <ScrollFadeExploreButton
          onClick={() => slidesRef.current?.next()}
          visible={activeIndex === 0}
        />
      )}

      {/* 首页三行布局：navbar(Topbar) + content(Swiper 翻页) + footer，
          用 flex 协调高度 —— main 固定为「视口 − navbar」，Swiper 占剩余、
          footer 收缩到底部，首屏即完整可见，不再溢出。 */}
      <main className="relative z-10 flex h-[calc(100dvh-4rem)] flex-col">
        <div className="min-h-0 flex-1">
          {/* 全屏幻灯：Swiper 垂直翻页，左侧进度点导航；内容页半透明深色遮罩 */}
          <FullscreenSlides
            ref={slidesRef}
            contentOverlay
            onActiveChange={handleSlideChange}
            slides={slides}
          />
        </div>

        {/* 全站统一 footer（与子页面共用，视觉/样式一致） */}
        <SiteFooter />
      </main>
    </>
  )
}

/** 底部「探索更多」按钮：fixed 首页底部，仅首页屏显示、翻屏后淡出隐藏 */
function ScrollFadeExploreButton({
  onClick,
  visible,
}: {
  onClick: () => void
  visible: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={cn(
        "fixed bottom-14 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5 text-white/70 transition-opacity duration-500 hover:text-white",
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      aria-label="探索更多"
    >
      <span className="text-xs font-medium tracking-[0.2em]">探索更多</span>
      <ChevronDown className="size-5 animate-bounce" />
    </button>
  )
}
