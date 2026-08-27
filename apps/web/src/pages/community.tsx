import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { animate } from "animejs"
import {
  ArrowLeftRight,
  ArrowUp,
  Flame,
  Link2,
  MessagesSquare,
  PenLine,
  Search,
  User,
} from "lucide-react"
import { Link, useLocation } from "react-router-dom"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"

import { useAuth } from "@/hooks/use-auth"
import {
  deriveCategories,
  formatRelativeTime,
  loadDiscussionCategories,
  resolveCommunity,
  resolveLiveLoader,
  resolveSeedLoader,
  sortDiscussionsHot,
  sortDiscussionsLatest,
  subscribeDiscussions,
  type CommunitySource,
  type DiscussionSummary,
} from "@/lib/github/discussions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { usePageEnter } from "@/components/showcase/page-enter"
import { PageHeader } from "@/components/layout/page-header"
import type { ThemeColors } from "@/lib/theme/auto-color"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// /community —— 讨论交流社区面板（主社区 = evil7/deepSea，可互动）
//   主社区（自有仓库 discussions）的增强浏览：
//   · 分类分区（Announcements / General / Ideas / Q&A / Show Your Plugins! / 闲聊灌水）
//   · 搜索过滤 + 排序（热门=评论数 / 最新=updatedAt）
//   · 列表卡片（分类徽章 / 作者头像 / 评论数 / 相对时间）
//   · 登录后可进入详情（worker 代理 GraphQL 正文+评论，可回复/表态）
//   · 发起讨论跳转主社区 /discussions/new
//   · 官方 deepseek-ai 社区仅作「只读」跳转链接（页头按钮）
// ---------------------------------------------------------------------------

type SortMode = "hot" | "latest"
type CategoryFilter = "ALL" | string

const PAGE_SIZE = 10

const CATEGORY_STYLES: Record<string, string> = {
  Announcements: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  General: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  Ideas: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  "Q&A": "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  "Show and tell": "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  Polls: "border-rose-400/30 bg-rose-400/10 text-rose-300",
}

/** 分类色条（列表项左侧强调色，与徽章同色系） */
const CATEGORY_ACCENTS: Record<string, string> = {
  Announcements: "bg-amber-400/70",
  General: "bg-sky-400/70",
  Ideas: "bg-violet-400/70",
  "Q&A": "bg-emerald-400/70",
  "Show and tell": "bg-cyan-400/70",
  Polls: "bg-rose-400/70",
}

/** 手动可配置三色（社区主题配色） */
const COMMUNITY_THEME: Record<CommunitySource, ThemeColors> = {
  dsh: { primary: "#38bdf8", secondary: "#0ea5e9", accent: "#818cf8" },
  dpc: { primary: "#22d3ee", secondary: "#67e8f9", accent: "#fbbf24" },
}

/** 作者小头像：URL 非空才渲染 img，否则 User 图标 fallback（杜绝空 src 警告） */
function AuthorAvatar({ url, name }: { url?: string; name: string }) {
  return (
    <Avatar size="sm" className="border border-border bg-muted">
      {url ? <AvatarImage src={url} alt={name} /> : null}
      <AvatarFallback className="bg-muted text-muted-foreground">
        <User className="size-3.5" />
      </AvatarFallback>
    </Avatar>
  )
}

export function CommunityPage() {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  // 社区来源：/community/dsh（蓝鲸社区，只读）| /community/dpc（浪尖酒馆，可互动）
  // 路由为静态段（无 :source 参数），需从 pathname 解析来源
  const { pathname } = useLocation()
  const source: CommunitySource =
    pathname.split("/")[2] === "dsh" ? "dsh" : "dpc"
  // t 引用随语言变化 → 语言切换时重新解析社区文案（label/description/对侧名）
  const info = useMemo(() => resolveCommunity(source, t), [source, t, i18n.language])

  // 社区主题配色：注入 CSS 变量，社区组件通过 --theme-primary/secondary/accent 自适应
  const theme: ThemeColors = COMMUNITY_THEME[info.source]
  const themeVars = {
    "--theme-primary": theme.primary,
    "--theme-secondary": theme.secondary,
    "--theme-accent": theme.accent,
  } as CSSProperties

  const [list, setList] = useState<DiscussionSummary[] | null>(null)
  const [mode, setMode] = useState<SortMode>("hot")
  const [category, setCategory] = useState<CategoryFilter>("ALL")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  // 分类：登录后取 GitHub 真实分类（含 id）；匿名从 seed 数据推导
  const [categories, setCategories] = useState<string[]>([])

  // 社区切换（dsh ↔ dpc）左右平移过渡：新内容从对应方向滑入。
  //   · dsh（蓝鲸社区，官方，在首页位于左侧）→ 从左侧滑入
  //   · dpc（浪尖酒馆，自有，在首页位于右侧）→ 从右侧滑入
  const contentRef = usePageEnter<HTMLDivElement>()
  const prevSourceRef = useRef<string>(info.source)
  useEffect(() => {
    if (prevSourceRef.current === info.source) return
    prevSourceRef.current = info.source
    const el = contentRef.current
    if (!el) return
    const from = info.source === "dsh" ? -56 : 56
    animate(el, {
      translateX: [from, 0],
      opacity: [0, 1],
      duration: 480,
      ease: "outExpo",
      // 清除残留 transform：否则 sticky 页头（PageHeader）会失效
      onComplete: () => {
        el.style.transform = ""
        el.style.opacity = ""
      },
    })
    // contentRef 是 usePageEnter 返回的稳定 ref，无需（也不应）加入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.source])

  useEffect(() => {
    let alive = true
    // 切换社区 / 登录态变化 → 立即重置为占位状态（Skeleton），避免新数据加载期间
    // 卡在上一社区 / 上一登录态的旧数据上。
    setList(null)
    setCategories([])

    // 分层加载（先缓存/骨架 → 后实时内容）：
    //   ① 先读静态 seed（本地缓存/静态 JSON，瞬时）立即渲染——切换社区不转圈、
    //      不卡上一社区数据，登录态也先有内容可看；
    //   ② 登录态再拉 GraphQL live（后台，全量替换 seed 为最新，失败静默保留 seed）。
    // 订阅 worker 推送（登录后每 3 分钟同步主社区）也会触发重新拉取。
    const load = () => {
      resolveSeedLoader(source)().then((seed) => {
        if (alive) {
          setList(seed)
        }
      })
      if (user) {
        resolveLiveLoader(source)().then((data) => {
          if (alive && data) {
            setList(data)
          }
        })
      }
    }
    load()
    // 订阅数据刷新（登录用户由前端 worker 每 3 分钟同步最新列表；官方社区静态 seed）
    const unsubscribe = subscribeDiscussions(load)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [source, user])

  // 登录后拉取 GitHub 真实分类（仅我们的社区；蓝鲸社区从 seed 推导）
  useEffect(() => {
    if (!user || info.source === "dsh") {
      return
    }
    let alive = true
    loadDiscussionCategories().then((cats) => {
      if (alive && cats.length > 0) {
        setCategories(cats.map((c) => c.name))
      }
    })
    return () => {
      alive = false
    }
  }, [user, info.source])

  // 蓝鲸社区 / 未登录时：从 seed 数据推导真实分类
  useEffect(() => {
    if (!list) {
      return
    }
    if (info.source === "dsh" || !user) {
      setCategories(deriveCategories(list))
    }
  }, [user, list, info.source])

  const filtered = useMemo(() => {
    if (!list) {
      return []
    }
    const q = query.trim().toLowerCase()
    let out = list.filter(
      (d) =>
        (category === "ALL" || d.categoryName === category) &&
        (!q ||
          d.title.toLowerCase().includes(q) ||
          d.author.toLowerCase().includes(q))
    )
    out = mode === "hot" ? sortDiscussionsHot(out) : sortDiscussionsLatest(out)
    return out
  }, [list, mode, category, query])

  // 分页
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE
  )

  // 筛选/搜索变化 → 回第一页
  useEffect(() => {
    setPage(0)
  }, [mode, category, query])

  const startNew = () => {
    if (!user) {
      toast.info(t("community.needLoginToast"))
      return
    }
    window.open(info.createUrl, "_blank", "noopener,noreferrer")
  }

  return (
    <>
      <div
        ref={contentRef}
        style={themeVars}
        className="relative z-10 mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-7xl px-4 py-10 sm:px-6"
      >
      {/* 页头：标题 + 描述 + 操作（共享 PageHeader，sticky 吸附变形） */}
      <PageHeader
        title={info.label}
        description={
          <div className="hidden items-center gap-2 sm:flex">
            <Badge
              className={cn(
                "shrink-0 font-mono text-[10px]",
                info.source === "dpc"
                  ? "border-theme-soft bg-theme-soft text-theme"
                  : "border-amber-400/40 bg-amber-400/10 text-amber-300"
              )}
            >
              {info.source === "dpc" ? t("community.ownBadge") : t("community.officialBadge")}
            </Badge>
            <p className="text-muted-foreground">{info.description}</p>
          </div>
        }
        actions={
          <>
            {/* 手机端：icon-only 前往对侧社区（左右交换图标） */}
            <Button
              asChild
              size="icon"
              variant="outline"
              className="size-9 border-border bg-card text-foreground hover:bg-accent sm:hidden"
              aria-label={t("community.goto", { name: info.counterpartLabel })}
            >
              <Link to={`/community/${info.counterpartSource}`}>
                <ArrowLeftRight className="size-5" />
              </Link>
            </Button>
            {/* 桌面端：左右交换 icon + 对侧社区名（与手机版 icon 一致；sticky 吸附后隐藏） */}
            <Button
              asChild
              variant="outline"
              className="hidden border-border bg-card text-foreground hover:bg-accent group-data-[stuck=true]:hidden! sm:inline-flex"
            >
              <Link to={`/community/${info.counterpartSource}`}>
                <ArrowLeftRight className="size-4" />
                {info.counterpartLabel}
              </Link>
            </Button>
            <Button size="sm" onClick={startNew} className="hidden sm:inline-flex">
              <PenLine className="size-4" />
              {t("community.new")}
            </Button>
          </>
        }
      />

      {/* 工具栏：搜索 + 排序 + 分类分区（主题描边 + 左上柔光；手机端隐藏，
          只保留社区名 + 交换按钮 + 列表） */}
      <div className="community-panel hidden rounded-xl border border-border p-4 sm:block">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 basis-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("community.searchPlaceholder")}
              className="h-9 border-border bg-background pl-9 text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as SortMode)}
            className="shrink-0"
          >
            <TabsList className="h-8 border border-border bg-muted">
              <TabsTrigger value="hot" className="gap-1.5">
                <Flame className="size-3.5 text-orange-400" />
                {t("community.hot")}
              </TabsTrigger>
              <TabsTrigger value="latest" className="gap-1.5">
                <Link2 className="size-3.5 text-sky-400" />
                {t("community.latest")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* 分类分区 */}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setCategory("ALL")}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              category === "ALL"
                ? "border-theme-soft bg-theme-soft text-theme"
                : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {t("community.categoryAll")}
          </button>
          {categories.map((c) => {
            const count = list?.filter((d) => d.categoryName === c).length ?? 0
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  category === c
                    ? "border-theme-soft bg-theme-soft text-theme"
                    : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {c}
                <span className="ml-1.5 opacity-50">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 列表 */}
      <div className="mt-6 space-y-3">
        {!list ? (
          Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={`skeleton-${i}`} className="h-16 w-full" />
          ))
        ) : pageItems.length === 0 ? (
          <div className="community-panel rounded-lg border border-border px-6 py-12 text-center text-sm text-muted-foreground">
            {t("community.empty")}
          </div>
        ) : (
          pageItems.map((d) => (
            <Link
              key={d.number}
              to={`/community/${info.source}/${d.number}`}
              className="community-card group relative flex items-center gap-4 overflow-hidden rounded-xl border border-border py-3 pr-4 pl-4 hover-theme-border"
            >
              {/* 左侧分类色条 */}
              <span
                aria-hidden="true"
                className={cn(
                  "community-card-bar absolute inset-y-0 left-0 w-1",
                  CATEGORY_ACCENTS[d.categoryName] ?? "bg-muted-foreground/40"
                )}
              />
              <div className="min-w-0 flex-1 pl-2">
                <div className="flex items-center gap-2">
                  <Badge
                    className={cn(
                      "shrink-0 font-mono text-[10px]",
                      CATEGORY_STYLES[d.categoryName] ??
                        "border-border bg-accent text-foreground"
                    )}
                  >
                    {d.categoryName}
                  </Badge>
                  <span className="font-mono text-xs text-theme">
                    #{d.number}
                  </span>
                </div>
                <p className="mt-1.5 truncate text-sm font-semibold text-foreground transition-colors group-hover:text-(--theme-primary)">
                  {d.title}
                </p>
                <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <AuthorAvatar url={d.avatarUrl} name={d.author} />
                  <span className="text-foreground/80">{d.author}</span>
                  <span>·</span>
                  {formatRelativeTime(d.updatedAt)}
                </p>
              </div>
              {/* 尾部统计：评论数 + 投票数（icon + 数字，无文字；仅桌面显示，
                  手机端只显示纯卡片，不展示回复/投票数量） */}
              <div className="hidden shrink-0 items-center gap-2 sm:flex">
                <div className="community-stat-chip flex items-center gap-1.5 rounded-lg px-2.5 py-1.5">
                  <MessagesSquare className="size-3.5 text-theme-accent" />
                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {d.comments}
                  </span>
                </div>
                <div className="community-stat-chip flex items-center gap-1.5 rounded-lg px-2.5 py-1.5">
                  <ArrowUp className="size-3.5 text-theme-accent" />
                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {d.upvoteCount ?? 0}
                  </span>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>

      {/* 分页 */}
      {list && pageCount > 1 && (
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="text-muted-foreground"
          >
            {t("common.prevPage")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {safePage + 1} / {pageCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            className="text-muted-foreground"
          >
            {t("common.nextPage")}
          </Button>
        </div>
      )}
      </div>
    </>
  )
}
