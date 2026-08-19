import { useEffect, useRef } from "react"
import {
  Beer,
  ChevronDown,
  Package,
  Palette,
  Plug,
  Radio,
  ShieldCheck,
} from "lucide-react"
import { Link } from "react-router-dom"

import { ComingSoonSlide } from "@/components/home/coming-soon"
import { CommunitySlide } from "@/components/home/community-slide"
import { Features } from "@/components/home/features"
import { InstallCommand } from "@/components/home/install-command"
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
                <div className="relative h-full">
                  {/* 内容锚定视口正中心（百分比定位）：
                      section 从顶部导航下方开始（导航高 4rem），
                      section 高度 = 100dvh - 4rem → 其 50% 点比视口中心低 2rem。
                      用 top-[calc(50%-2rem)] 抵消导航占位：
                      内容中心 = 4rem + (100dvh-4rem)/2 - 2rem = 50dvh = 视口中心，
                      任意屏幕尺寸/比例下内容相对视口中心不偏移 */}
                  <div className="absolute inset-x-0 top-[calc(50%-2rem)] -translate-y-1/2 px-4 text-center sm:px-6">
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
                    {/* deepc 安装命令：终端风格，一眼可见（独立组件 + 自定义 CSS） */}
                    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
                        <Link to="/community">
                          <Beer className="size-4" />
                          把酒言欢
                        </Link>
                      </Button>
                    </div>
                    <InstallCommand />
                  </div>
                </div>
              ),
            },
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
                  description="把 deepSea 装进口袋：一套 deepc 组合包，搞定主题、插件管理与多端互联。"
                  items={[
                    {
                      id: "theme",
                      icon: Palette,
                      title: "一致主题",
                      description:
                        "约定 DeepcTheme 主题文档规范，local 直接调用官方 theme.register 移植优秀主题，remote 经 P2P/私有 gist 同步各端，一套主题多端一致。",
                      tag: "theme",
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
                      id: "sync",
                      icon: Radio,
                      title: "多端互联",
                      description:
                        "WebRTC 实时 P2P 加私有 gist 端到端加密同步，deepc.cn 统一界面多端调用 dsh、对话同步，免 nginx 反代风险。",
                      tag: "sync",
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
