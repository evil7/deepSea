import { useEffect, useRef } from "react"
import {
  ChevronDown,
  Compass,
  MessagesSquare,
  MonitorSmartphone,
  Package,
  Plug,
  Palette,
} from "lucide-react"
import { Link } from "react-router-dom"

import { ComingSoonSlide } from "@/components/home/coming-soon"
import { Features } from "@/components/home/features"
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

interface HomePageProps {
  /** 当前海洋状态（由 App 统一管理：路由 + 首页翻屏共同驱动） */
  seaState: SeaState
  /** 首页翻屏/滚动 → 上报海洋状态（App 仅在首页路由时采纳） */
  onSeaStateChange: (state: SeaState) => void
}

export function HomePage({ seaState, onSeaStateChange }: HomePageProps) {
  // 全屏幻灯控制句柄（「探索更多」等入口统一走幻灯跳转）
  const slidesRef = useRef<FullscreenSlidesHandle>(null)

  // 翻屏（滚动/点击进度点/探索更多）→ 统一上报海洋状态：进入核心能力屏即深海
  const handleSlideChange = (index: number) => {
    onSeaStateChange(index >= DEEP_SLIDE_INDEX ? "deep" : "surface")
  }

  return (
    <>
      {/* 沉入海底的入口：fixed 在首页底部；滚动即淡出，回顶部重现 */}
      <ScrollFadeExploreButton onClick={() => slidesRef.current?.next()} />

      <main className="relative z-10">
        {/* 全屏幻灯：每屏固定占满视口，左侧进度点导航；内容页半透明深色遮罩 */}
        <FullscreenSlides
          ref={slidesRef}
          heightClass="h-[calc(100dvh-4rem)]"
          contentOverlay
          onActiveChange={handleSlideChange}
          slides={[
            {
              id: "hero",
              label: "首页",
              node: (
                <div className="relative flex h-full items-center justify-center">
                  <div className="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
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
                      网罗优秀生态插件的快速搜索、下载使用，社区讨论、安全管理。
                      <br />
                      风浪越大，收获越多。
                    </p>
                    <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
                      <Button
                        asChild
                        size="lg"
                        variant="outline"
                        className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                      >
                        <Link to="/plugins">
                          <Plug className="size-4" />
                          大海捞珍
                        </Link>
                      </Button>
                      <Button
                        asChild
                        size="lg"
                        variant="outline"
                        className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                      >
                        <Link to="/#community">
                          <MessagesSquare className="size-4" />
                          港口酒馆
                        </Link>
                      </Button>
                    </div>
                  </div>
                </div>
              ),
            },
            {
              // 万物皆插件：原第三屏（核心能力）上移到第二屏；轻雾遮罩
              id: "explore",
              label: "万物皆插件",
              overlayClassName: "bg-slate-950/40 backdrop-blur-[2px]",
              node: <Features active={seaState === "deep"} />,
            },
            {
              // 插件精选：原第二屏移到第三屏；中雾遮罩
              id: "plugins",
              label: "插件精选",
              overlayClassName: "bg-slate-950/55 backdrop-blur-md",
              node: <PluginPreview />,
            },
            {
              // 社区动态：占位（后续接入 discussions）；深雾遮罩
              id: "community",
              label: "社区动态",
              overlayClassName: "bg-slate-950/65 backdrop-blur-md",
              node: (
                <ComingSoonSlide
                  eyebrow="04 · COMMUNITY"
                  title="社区动态"
                  description="基于官方 discussions 包装的更顺滑社区：分区浏览、热度排序、讨论详情，发帖直达官方。"
                  items={[
                    {
                      id: "discussions",
                      icon: MessagesSquare,
                      title: "讨论分区",
                      description:
                        "按分类分区浏览官方 discussions，热门讨论与最新动态一目了然。",
                      tag: "dsh-discussions-hub",
                    },
                    {
                      id: "heat",
                      icon: Compass,
                      title: "热度排序",
                      description:
                        "按讨论热度/活跃度排序，快速发现社区当前最关注的话题。",
                      tag: "hot-topic",
                    },
                  ]}
                />
              ),
            },
            {
              // 深海套装：占位（后续提供 deepsea 主题/插件管理/多端互联）；浓雾遮罩
              id: "deepsea-kit",
              label: "深海套装",
              overlayClassName: "bg-slate-950/75 backdrop-blur-lg",
              node: (
                <ComingSoonSlide
                  eyebrow="05 · DEEPSEA KIT"
                  title="深海套装"
                  description="把 deepSea 装进口袋：主题、管理与多端互联，一套带走。"
                  items={[
                    {
                      id: "theme",
                      icon: Palette,
                      title: "deepsea 主题",
                      description:
                        "深海海洋视觉主题，一键应用到你的插件与工具，保持深海氛围。",
                      tag: "theme",
                    },
                    {
                      id: "manage",
                      icon: Package,
                      title: "插件管理插件",
                      description:
                        "本地安装、更新提示一站式管理，deepc 插件可复刻本站用于本地。",
                      tag: "deepc",
                    },
                    {
                      id: "sync",
                      icon: MonitorSmartphone,
                      title: "多端互联插件",
                      description:
                        "桌面端与移动端互通，插件与配置跨设备同步，随时随地下潜。",
                      tag: "sync",
                    },
                  ]}
                />
              ),
            },
          ]}
        />

        <footer className="border-t border-white/10 bg-slate-950/60 py-10 backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-sm text-white/70 sm:flex-row sm:px-6">
            <p>deepSea · DeepSeek Harness 插件生态聚合站</p>
            <p className="font-mono">dsh · deepc · everything is a plugin</p>
          </div>
        </footer>
      </main>
    </>
  )
}

/** 底部「探索更多」按钮：fixed 首页底部，滚动淡出、回顶重现 */
function ScrollFadeExploreButton({ onClick }: { onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useScrollFade(ref)
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="fixed bottom-10 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5 text-white/70 transition-all duration-500 hover:text-white"
      aria-label="探索更多"
    >
      <span className="text-xs font-medium tracking-[0.2em]">探索更多</span>
      <ChevronDown className="size-5 animate-bounce" />
    </button>
  )
}

/** 滚动越过一屏 12% 淡出按钮，回到顶部附近重现 */
function useScrollFade(ref: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    const onScroll = () => {
      const hidden = window.scrollY >= window.innerHeight * 0.12
      el.classList.toggle("pointer-events-none", hidden)
      el.classList.toggle("opacity-0", hidden)
      el.classList.toggle("opacity-100", !hidden)
      el.setAttribute("aria-hidden", String(hidden))
      el.tabIndex = hidden ? -1 : 0
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener("scroll", onScroll)
  }, [ref])
}
