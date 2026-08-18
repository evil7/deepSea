import { useEffect, useRef, useState } from "react"
import { ChevronDown, Plug, MessagesSquare } from "lucide-react"

import { Features } from "@/components/home/features"
import {
  FullscreenSlides,
  type FullscreenSlidesHandle,
} from "@/components/layout/fullscreen-slides"
import { Topbar } from "@/components/layout/topbar"
import type { OceanConf } from "@/components/showcase/ocean-conf"
import { Ocean } from "@/components/showcase/ocean"
import { SeaDebugPanel } from "@/components/showcase/sea-debug-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export function App() {
  // 海洋参数配置（调试面板 #sea-debug 调整；也可以直接写 JSON 对象）
  const [conf, setConf] = useState<Partial<OceanConf>>({})
  // 全屏幻灯控制句柄（「探索更多」等入口统一走幻灯跳转）
  const slidesRef = useRef<FullscreenSlidesHandle>(null)
  // 「探索更多」按钮：fixed 在首页底部，开始滚动后淡出，回到顶部重现
  const [showExplore, setShowExplore] = useState(true)

  useEffect(() => {
    const onScroll = () => {
      // 视口内滚动超过阈值（约一屏的 12%）即淡出；回到顶部附近重现
      setShowExplore(window.scrollY < window.innerHeight * 0.12)
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div id="top" className="min-h-dvh">
      {/* 3D 海面背景：滚动触发潜入海底（丁达尔光柱 + caustics 折射光影 + 漂浮代码） */}
      <Ocean conf={conf} />

      {/* 调试面板：地址 #sea-debug 显示，滑块调参 + 复制 JSON */}
      <SeaDebugPanel conf={conf} onChange={setConf} />

      <Topbar />

      {/* 沉入海底的入口：fixed 在首页底部；滚动即淡出，回顶部重现 */}
      <button
        type="button"
        onClick={() => slidesRef.current?.next()}
        aria-hidden={!showExplore}
        tabIndex={showExplore ? 0 : -1}
        className={`fixed bottom-10 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5 text-white/70 transition-all duration-500 hover:text-white ${
          showExplore ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span className="text-xs font-medium tracking-[0.2em]">探索更多</span>
        <ChevronDown className="size-5 animate-bounce" />
      </button>

      <main className="relative z-10">
        {/* 全屏幻灯：每屏固定占满视口，左侧进度点导航；内容页半透明深色遮罩 */}
        <FullscreenSlides
          ref={slidesRef}
          heightClass="h-[calc(100dvh-4rem)]"
          contentOverlay
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
                      DeepSeek Harness 插件生态聚合站
                    </Badge>
                    <h1 className="mt-6 text-5xl font-bold tracking-tight text-white drop-shadow-[0_2px_16px_rgba(8,26,61,0.9)] sm:text-7xl">
                      deepSea
                    </h1>
                    <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-white/85 drop-shadow-[0_1px_8px_rgba(8,26,61,0.9)] sm:text-lg">
                      搜罗与聚类 deepseek-harness
                      周边插件生态。快速搜索、下载使用，
                      从社区讨论到安全管理，潜得越深，收获越多。
                    </p>
                    <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
                      <Button asChild size="lg">
                        <a href="#explore">
                          <Plug className="size-4" />
                          大海捞珍
                        </a>
                      </Button>
                      <Button
                        asChild
                        size="lg"
                        variant="outline"
                        className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                      >
                        <a href="#community">
                          <MessagesSquare className="size-4" />
                          港口酒馆
                        </a>
                      </Button>
                    </div>
                  </div>
                </div>
              ),
            },
            {
              id: "explore",
              label: "核心能力",
              node: <Features />,
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
    </div>
  )
}

export default App
