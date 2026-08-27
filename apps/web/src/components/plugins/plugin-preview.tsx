import { useEffect, useMemo, useState } from "react"
import { Flame, Link2, Star } from "lucide-react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { PluginFanDeck } from "@/components/plugins/plugin-coverflow"
import { useSlideReveal } from "@/components/showcase/slide-reveal"
import { useIsMobile } from "@/hooks/use-mobile"
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

function formatStars(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return String(n)
}

export function PluginPreview() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
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
            02 · CURATED
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            {t("home.slideCurated")}
          </h2>
          <p className="mt-1 text-sm text-white/65">
            {t("home.featureCuratedDesc")}
          </p>
        </div>
        {/* 热门 | 最新：shadcn Tabs 默认样式（跟随主题圆角） */}
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as ViewMode)}
          className="w-fit"
        >
          <TabsList className="h-8 border border-white/15 bg-slate-900/70 text-xs">
            <TabsTrigger
              value="hot"
              className="text-white/60 hover:text-white data-active:bg-white/15 data-active:text-white"
            >
              <Flame className="size-3.5" />
              {t("plugins.hot")}
            </TabsTrigger>
            <TabsTrigger
              value="latest"
              className="text-white/60 hover:text-white data-active:bg-white/15 data-active:text-white"
            >
              <Link2 className="size-3.5" />
              {t("plugins.latest")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* 码牌叠放画廊（整体随标题上浮淡入；卡片自身由 animejs 抽出动画控制） */}
      {!repos ? (
        <div className="slide-reveal-item grid h-107 w-full place-items-center">
          <Skeleton className="h-87.5 w-62.5 rounded-2xl bg-white/5" />
        </div>
      ) : isMobile ? (
        // 移动端：FanDeck 固定卡宽+铺满会横向溢出且 hover 交互失效，降级为
        // 横向滚动卡片列表（触摸滑动，snap 对齐）
        <div className="slide-reveal-item -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
          {top10.map((repo) => {
            const [owner, name] = repo.full_name.split("/")
            return (
              <Link
                key={repo.full_name}
                to={`/plugin/${owner}/${name}`}
                className="flex w-44 shrink-0 snap-start flex-col rounded-2xl border border-white/10 bg-slate-900/70 p-4"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 font-mono text-xs font-bold text-cyan-300">
                    {owner.slice(0, 1).toUpperCase()}
                  </div>
                  <h3 className="truncate font-mono text-sm font-semibold text-white">
                    {name}
                  </h3>
                </div>
                <p className="mt-2 line-clamp-3 flex-1 text-xs leading-relaxed text-white/60">
                  {repo.description || t("common.noDescription")}
                </p>
                <div className="mt-3 flex items-center gap-1.5 border-t border-white/10 pt-3 text-xs text-white/50">
                  <Star className="size-3.5 text-amber-300" />
                  <span className="tabular-nums text-white/80">
                    {formatStars(repo.stargazers_count)}
                  </span>
                  {repo.language && (
                    <span className="ml-auto truncate">{repo.language}</span>
                  )}
                </div>
              </Link>
            )
          })}
          {/* more 卡：跳全部插件 */}
          <Link
            to="/plugins"
            className="flex w-24 shrink-0 snap-start items-center justify-center rounded-2xl border border-white/10 bg-slate-900/70 p-4"
          >
            <span className="text-sm font-medium text-cyan-300">{t("common.viewAll")} →</span>
          </Link>
        </div>
      ) : (
        <div className="slide-reveal-item">
          <PluginFanDeck repos={top10} />
        </div>
      )}
    </div>
  )
}
