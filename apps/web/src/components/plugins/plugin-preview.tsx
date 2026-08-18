import { useEffect, useMemo, useState } from "react"
import { Flame, Link2 } from "lucide-react"

import { PluginFanDeck } from "@/components/plugins/plugin-coverflow"
import { useSlideReveal } from "@/components/showcase/slide-reveal"
import { loadPluginSeed, sortPlugins } from "@/lib/github/search"
import { PLUGIN_SEED_URL } from "@/lib/github/topics"
import type { PluginRepo } from "@/lib/github/types"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

// ---------------------------------------------------------------------------
// 主页「插件精选」模块：前 10 个插件，热门 | 最新 切换，封面流画廊展示
// 数据：种子 JSON（scripts 脚本同步产出，无 API 消耗）
// ---------------------------------------------------------------------------

type ViewMode = "hot" | "latest"

export function PluginPreview() {
  const [repos, setRepos] = useState<PluginRepo[] | null>(null)
  const [mode, setMode] = useState<ViewMode>("hot")

  useEffect(() => {
    let alive = true
    loadPluginSeed(PLUGIN_SEED_URL).then((data) => {
      if (alive) {
        setRepos(data)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const top10 = useMemo(() => {
    if (!repos) {
      return []
    }
    return sortPlugins(repos, mode).slice(0, 10)
  }, [repos, mode])

  // animejs 进入动画：标题区上浮 → 卡片 stagger（进入视口触发）
  const sectionRef = useSlideReveal<HTMLDivElement>()

  return (
    <div
      ref={sectionRef}
      className="mx-auto flex h-full w-full max-w-7xl flex-col justify-center px-4 py-10 sm:px-6"
    >
      {/* 杂志化标题区：眉题编号 + 左对齐标题 + 切换（下间距加大，
          给下方放大抽出的卡牌留出顶部空间，避免覆盖） */}
      <div className="slide-reveal-title mb-10 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-[0.3em] text-cyan-300/90">
            03 · CURATED
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            插件精选
          </h2>
          <p className="mt-1 text-sm text-white/65">
            深海里打捞上来的热门 deepseek-harness 插件
          </p>
        </div>
        {/* 热门 | 最新：shadcn Tabs 默认样式（跟随主题圆角） */}
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as ViewMode)}
          className="w-fit"
        >
          <TabsList className="h-8 border border-white/15 bg-slate-900/70 text-xs">
            <TabsTrigger value="hot">
              <Flame className="size-3.5" />
              热门
            </TabsTrigger>
            <TabsTrigger value="latest">
              <Link2 className="size-3.5" />
              最新
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* 码牌叠放画廊（整体随标题上浮淡入；卡片自身由 animejs 抽出动画控制） */}
      {!repos ? (
        <div className="slide-reveal-item grid h-[428px] w-full place-items-center">
          <Skeleton className="h-[350px] w-[250px] rounded-2xl bg-white/5" />
        </div>
      ) : (
        <div className="slide-reveal-item">
          <PluginFanDeck repos={top10} />
        </div>
      )}
    </div>
  )
}
