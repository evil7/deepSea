import { useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  GitFork,
  Info,
  RefreshCw,
  Search,
  Star,
} from "lucide-react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"

import { getToken } from "@/lib/github/client"
import {
  collectLanguages,
  filterPlugins,
  liveSearchReposByFilter,
  loadPluginSeed,
  sortPlugins,
} from "@/lib/github/search"
import { PLUGIN_SEED_URL } from "@/lib/github/topics"
import type { PluginRepo } from "@/lib/github/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { usePageEnter } from "@/components/showcase/page-enter"
import { PageHeader } from "@/components/layout/page-header"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// /plugins —— 插件生态快速搜索页
//   · 输入框：即时过滤本地缓存种子（零 API 配额）
//   · 搜索按钮：按当前条件实时查询 GitHub（默认过滤官方 topic dsh-plugin，
//     需登录 token）
// ---------------------------------------------------------------------------

const PAGE_SIZE = 12

/** 骨架屏占位 key（静态，避免 index key） */
const SKELETON_KEYS = Array.from({ length: 6 }, (_, i) => `skeleton-${i}`)

// star 快速过滤：默认「不限」（0 = 不过滤），且「不限」放首个。
// label 仅用于非 0 档位的数字格式展示（如 "≥ 10"）；0 档渲染时经 i18n 显示。
const STAR_LEVELS = [
  { label: "All", value: 0 },
  { label: "≥ 10", value: 10 },
  { label: "≥ 100", value: 100 },
  { label: "≥ 1k", value: 1000 },
  { label: "≥ 10k", value: 10000 },
]

/** 创建时间限制（created_at 距今 ≥ 该天数；0 = 不限）。
 *  缓存脚本不再按创建时间过滤，故默认「不限」；仅作额外筛选器供用户主动收紧。
 *  仅存 value，标签渲染时经 i18n（t("plugins.createdDays", { count })）。 */
const CREATED_LEVELS = [
  { value: 0 },
  { value: 5 },
  { value: 15 },
  { value: 30 },
]

/** Action 同步分钟（每小时第 23 分钟 UTC，与 sync-plugin-seed.yml 一致） */
const SYNC_MINUTE = 23

type ViewMode = "hot" | "latest"

function formatStars(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return String(n)
}

/** 距下次出海（自动同步）的分钟数 */
function minutesUntilNextSync(): number {
  const now = new Date()
  const next = new Date(now)
  if (now.getMinutes() >= SYNC_MINUTE) {
    next.setHours(now.getHours() + 1, SYNC_MINUTE, 0, 0)
  } else {
    next.setMinutes(SYNC_MINUTE, 0, 0)
  }
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 60000))
}

export function PluginsPage() {
  const { t } = useTranslation()
  const [repos, setRepos] = useState<PluginRepo[] | null>(null)
  const [keyword, setKeyword] = useState("")
  const [language, setLanguage] = useState<string | null>(null)
  // star 默认「不限」（0）；创建时间默认「不限」（0）
  const [starLevel, setStarLevel] = useState(0)
  const [createdWithin, setCreatedWithin] = useState(0)
  const [mode, setMode] = useState<ViewMode>("hot")
  const [searching, setSearching] = useState(false)
  const [page, setPage] = useState(1)
  const searchRef = useRef<HTMLInputElement>(null)

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

  /** 在线搜索：按当前过滤条件实时查询 GitHub（默认过滤官方 topic） */
  const handleLiveSearch = async () => {
    if (!getToken()) {
      toast.info(t("plugins.needLoginToast"))
      return
    }
    if (searching) {
      return
    }
    setSearching(true)
    try {
      const results = await liveSearchReposByFilter({
        keyword,
        language,
        minStars: starLevel,
        createdWithinDays: createdWithin,
      })
      if (results.length === 0) {
        toast.info(t("plugins.noCatchToast"))
      }
      setRepos(results)
      setPage(1)
    } catch {
      toast.error(t("plugins.searchFailedToast"))
    } finally {
      setSearching(false)
    }
  }

  // 语言分布（基于当前已加载数据）
  const languages = useMemo(
    () => (repos ? collectLanguages(repos) : []),
    [repos]
  )

  // 过滤 + 排序 + 分页
  const filtered = useMemo(() => {
    if (!repos) {
      return []
    }
    const f = filterPlugins(repos, {
      keyword,
      language,
      minStars: starLevel,
      createdWithinDays: createdWithin,
    })
    return sortPlugins(f, mode)
  }, [repos, keyword, language, starLevel, createdWithin, mode])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filtered.slice(start, start + PAGE_SIZE)
  }, [filtered, page])

  // 过滤条件变化时回到第一页
  // 宏任务：避免 effect 同步路径 setState（React Compiler set-state-in-effect lint）
  // 依赖数组为触发重算条件（函数体无需读取，豁免 exhaustive-deps 误报）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = window.setTimeout(() => setPage(1), 0)
    return () => window.clearTimeout(id)
  }, [keyword, language, starLevel, createdWithin, mode])

  /** star 过滤点击：直接更新本地过滤条件 */
  const handleStarClick = (value: number) => {
    setStarLevel(value)
  }

  /** 发布时间过滤点击：缓存不再按创建时间收录，「不限」是默认态、不触发切换 */
  const handleCreatedClick = (value: number) => {
    setCreatedWithin(value)
  }

  const pageNumbers = useMemo(() => {
    const items: { key: string; value: number | "…" }[] = []
    let ellipsisCount = 0
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - page) <= 1) {
        items.push({ key: String(i), value: i })
      } else if (items[items.length - 1]?.value !== "…") {
        ellipsisCount += 1
        items.push({ key: `ellipsis-${ellipsisCount}`, value: "…" })
      }
    }
    return items
  }, [totalPages, page])

  const pageRef = usePageEnter<HTMLDivElement>()

  return (
    <div
      ref={pageRef}
      className="relative z-10 mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-7xl px-4 py-10 sm:px-6"
    >
      {/* 页头（共享 PageHeader，sticky 吸附变形）
          手机端：标题右侧同排「热门|最新」切换（搜索栏整个移除，见下方 hidden） */}
      <PageHeader
        title={t("plugins.title")}
        actions={
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as ViewMode)}
            className="w-fit sm:hidden"
          >
            <TabsList className="h-8 border border-border bg-muted text-xs">
              <TabsTrigger value="hot">{t("plugins.hot")}</TabsTrigger>
              <TabsTrigger value="latest">{t("plugins.latest")}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {/* 搜索 + 过滤条（手机端隐藏：只留标题 + 热门/最新 + 列表 + 分页） */}
      <div className="hidden flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex">
        {/* 搜索框（输入即过滤缓存，点击搜索按钮在线查询） */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleLiveSearch()
                }
              }}
              placeholder={t("plugins.searchPlaceholder")}
              className="h-9 border-border bg-background pl-9 text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <Button
            size="sm"
            onClick={handleLiveSearch}
            disabled={searching}
            className="h-9 shrink-0 bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 hover:text-cyan-200"
          >
            <RefreshCw
              className={cn("size-3.5", searching && "animate-spin")}
            />
            {t("plugins.search")}
          </Button>
        </div>

        {/* 语言下拉 + star 限制 + 发布时间 + 来源模式切换 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t("plugins.language")}</span>
          <Select
            value={language ?? "all"}
            onValueChange={(v) => setLanguage(v === "all" ? null : v)}
          >
            <SelectTrigger
              size="sm"
              className="h-7 border-border bg-background text-xs text-foreground"
            >
              <SelectValue placeholder={t("plugins.allLanguage")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("plugins.allLanguage")}</SelectItem>
              {languages.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {lang}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="mx-1 hidden h-4 w-px bg-border sm:block" />

          <span className="text-[11px] text-muted-foreground">{t("plugins.stars")}</span>
          {STAR_LEVELS.map((s) => (
            <FilterBadge
              key={s.value}
              active={starLevel === s.value}
              onClick={() => handleStarClick(s.value)}
              label={s.value === 0 ? t("common.all") : s.label}
            />
          ))}

          <span className="mx-1 hidden h-4 w-px bg-border sm:block" />

          <span className="text-[11px] text-muted-foreground">{t("plugins.created")}</span>
          {CREATED_LEVELS.map((c) => (
            <FilterBadge
              key={c.value}
              active={createdWithin === c.value}
              onClick={() => handleCreatedClick(c.value)}
              label={c.value === 0 ? t("common.all") : t("plugins.createdDays", { count: c.value })}
            />
          ))}
        </div>
      </div>

      {/* 结果工具条：左 [热门|最新]，右 (info)已捕捞{n}个渔获（手机端隐藏，
          切换已上移到标题行 actions） */}
      <div className="mt-4 hidden items-center justify-between gap-3 sm:flex">
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as ViewMode)}
          className="w-fit"
        >
          <TabsList className="h-8 border border-border bg-muted text-xs">
            <TabsTrigger value="hot">{t("plugins.hot")}</TabsTrigger>
            <TabsTrigger value="latest">{t("plugins.latest")}</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* info + 已捕捞计数：同一标签组件，tooltip 左侧弹出、两行内容 */}
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="h-8 cursor-help gap-1.5 rounded-full border-border bg-card px-3 text-xs font-normal text-muted-foreground"
              >
                <Info className="size-3.5 text-muted-foreground" />
                {t("plugins.caught")}
                <span className="text-cyan-300">{filtered.length}</span>
                {t("plugins.catchCount")}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8}>
              <div className="flex flex-col gap-0.5">
                <p>{t("plugins.nextSyncIn", { minutes: minutesUntilNextSync() })}</p>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* 卡片列表 */}
      {!repos ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SKELETON_KEYS.map((key) => (
            <Skeleton key={key} className="h-40 rounded-xl bg-muted" />
          ))}
        </div>
      ) : pageItems.length === 0 ? (
        <div className="mt-16 text-center">
          <p className="text-sm text-muted-foreground">{t("plugins.noMatch")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("plugins.noMatchHint")}</p>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pageItems.map((repo) => (
            <PluginCard key={repo.full_name} repo={repo} />
          ))}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="text-muted-foreground hover:text-foreground"
            aria-label={t("common.prevPage")}
          >
            <ChevronLeft className="size-4" />
          </Button>
          {pageNumbers.map((item) => {
            if (item.value === "…") {
              return (
                <span key={item.key} className="px-1 text-xs text-muted-foreground">
                  …
                </span>
              )
            }
            const pageNumber = item.value
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setPage(pageNumber)}
                className={cn(
                  "min-w-8 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  pageNumber === page
                    ? "bg-cyan-500/20 text-cyan-300"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {pageNumber}
              </button>
            )
          })}
          <Button
            variant="ghost"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="text-muted-foreground hover:text-foreground"
            aria-label={t("common.nextPage")}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

function FilterBadge({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
        active
          ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-300"
          : "border-border bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  )
}

function PluginCard({ repo }: { repo: PluginRepo }) {
  const { t } = useTranslation()
  const [owner, name] = repo.full_name.split("/")
  return (
    <Link
      to={`/plugin/${owner}/${name}`}
      className="group flex min-w-0 flex-col rounded-xl border border-border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-cyan-400/40 hover:bg-accent"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 font-mono text-xs font-bold text-cyan-300">
            {owner.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-mono text-sm font-semibold text-foreground">
              {repo.full_name}
            </h3>
            <p className="truncate text-[11px] text-muted-foreground">
              {repo.language ?? t("common.unknownLanguage")}
              {repo.license ? ` · ${repo.license}` : ""}
            </p>
          </div>
        </div>
        {repo.is_official && (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-400/40 bg-amber-400/10 text-amber-300"
          >
            {t("common.official")}
          </Badge>
        )}
      </div>

      <p className="mt-3 line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
        {repo.description || t("common.noDescription")}
      </p>

      {/* 标签 */}
      {repo.topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {repo.topics.slice(0, 3).map((topic) => (
            <span
              key={topic}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {topic}
            </span>
          ))}
          {repo.topics.length > 3 && (
            <span className="text-[10px] text-muted-foreground">
              +{repo.topics.length - 3}
            </span>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center gap-3 pt-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Star className="size-3.5 text-amber-300" />
          {formatStars(repo.stargazers_count)}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="flex items-center gap-1">
          <GitFork className="size-3.5 text-muted-foreground" />
          {formatStars(repo.forks_count)}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {repo.pushed_at ? repo.pushed_at.slice(0, 10) : ""}
        </span>
      </div>
    </Link>
  )
}
