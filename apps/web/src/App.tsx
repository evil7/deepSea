import { ArrowRight, ChevronDown, ExternalLink } from "lucide-react"

import { Features } from "@/components/home/features"
import { Topbar } from "@/components/layout/topbar"
import { Ocean } from "@/components/showcase/ocean"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export function App() {
  return (
    <div id="top" className="min-h-svh">
      {/* 3D 海面背景：滚动触发潜入海底（丁达尔光柱 + caustics 折射光影 + 漂浮代码） */}
      <Ocean />

      <Topbar />

      <main className="relative z-10">
        {/* Hero：标题叠在 3D 海面之上 */}
        <section className="relative flex min-h-svh items-center justify-center">
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
              搜罗与聚类 deepseek-harness 周边插件生态。快速搜索、下载使用，
              从社区讨论到安全管理，潜得越深，收获越多。
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg">
                <a href="#explore">
                  探索插件生态
                  <ArrowRight className="size-4" />
                </a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
              >
                <a href="#community">
                  <ExternalLink className="size-4" />
                  进入社区
                </a>
              </Button>
            </div>
          </div>

          {/* 沉入海底的入口 */}
          <button
            type="button"
            onClick={() =>
              window.scrollTo({
                top: window.innerHeight * 0.6,
                behavior: "smooth",
              })
            }
            className="absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5 text-white/70 transition-colors hover:text-white"
          >
            <span className="text-xs font-medium tracking-[0.2em]">
              探索更多
            </span>
            <ChevronDown className="size-5 animate-bounce" />
          </button>
        </section>

        <Features />

        <footer className="border-t py-10">
          <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-sm text-muted-foreground sm:flex-row sm:px-6">
            <p>deepSea · DeepSeek Harness 插件生态聚合站</p>
            <p className="font-mono">dsh · deepc · everything is a plugin</p>
          </div>
        </footer>
      </main>
    </div>
  )
}

export default App
