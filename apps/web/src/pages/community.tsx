import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { animate } from "animejs"
import {
  ArrowLeft,
  Flame,
  Link2,
  MessagesSquare,
  PenLine,
  Search,
  User,
} from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { useAuth } from "@/hooks/use-auth"
import {
  deriveCategories,
  formatRelativeTime,
  loadDiscussionCategories,
  resolveCommunity,
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
import { useImageThemeColor } from "@/hooks/use-auto-color"
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

/** 是否开启背景图自动取色（autoColor）：分析背景图色调推选三色 */
const AUTO_COLOR = true

/** 手动可配置三色（autoColor 关闭或提取失败时的兜底配色） */
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

/**
 * 社区页背景：对应社区图（虚化 + 稍暗遮罩），随鼠标位置轻微位移。
 *   · 图片超出视口 125% + blur，位移时不会露出边缘
 *   · rAF 节流，位移幅度限制在小范围（x ±14px / y ±10px）
 *   · image 变化时淡入（crossfade 切换社区背景）
 */
function CommunityBackdrop({ image }: { image: string }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    let raf = 0
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const nx = e.clientX / window.innerWidth - 0.5
        const ny = e.clientY / window.innerHeight - 0.5
        setOffset({ x: nx * -14, y: ny * -10 })
      })
    }
    window.addEventListener("mousemove", onMove, { passive: true })
    return () => {
      window.removeEventListener("mousemove", onMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  // 社区背景切换时淡入（crossfade）
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    animate(img, {
      opacity: [0, 1],
      duration: 600,
      ease: "easeOutQuad",
    })
  }, [image])

  return (
    <div aria-hidden="true" className="fixed inset-0 z-0 overflow-hidden">
      <img
        ref={imgRef}
        src={image}
        alt=""
        className="absolute top-1/2 left-1/2 h-[125%] w-[125%] max-w-none object-cover blur-md"
        style={{
          transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(1.05)`,
        }}
      />
      {/* 稍暗遮罩：保证前景文字可读 */}
      <div className="absolute inset-0 bg-slate-950/72" />
    </div>
  )
}

export function CommunityPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  // 社区来源：?source=dsh（蓝鲸社区，只读）| dpc（浪尖酒馆，可互动，默认）
  const source = searchParams.get("source")
  const info = useMemo(() => resolveCommunity(source), [source])

  // 背景图 + 自动取色（autoColor）：分析背景图色调推选三色 → 注入 CSS 变量，
  // 社区组件通过 --theme-primary/secondary/accent 自适应（点阵渐变/主色调/点缀色）
  const backdropSrc = info.source === "dsh" ? "/c1.png" : "/c2.png"
  const { colors } = useImageThemeColor(AUTO_COLOR ? backdropSrc : null)
  const theme: ThemeColors = colors ?? COMMUNITY_THEME[info.source]
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
    const loadSeed = resolveSeedLoader(source)
    const load = () => {
      loadSeed().then((data) => {
        if (alive) {
          setList(data)
        }
      })
    }
    load()
    // 订阅数据刷新（登录用户由前端 worker 每 3 分钟同步最新列表；官方社区静态 seed）
    const unsubscribe = subscribeDiscussions(load)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [source])

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
      toast.info("请先登录，再发起讨论")
      return
    }
    window.open(info.createUrl, "_blank", "noopener,noreferrer")
  }

  return (
    <>
      <CommunityBackdrop image={backdropSrc} />
      <div
        ref={contentRef}
        style={themeVars}
        className="relative z-10 mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-7xl px-4 py-10 sm:px-6"
      >
      {/* 页头：标题 + 描述 + 操作（共享 PageHeader，sticky 吸附变形） */}
      <PageHeader
        title={info.label}
        description={
          <div className="flex items-center gap-2">
            <Badge
              className={cn(
                "shrink-0 font-mono text-[10px]",
                info.replyEnable
                  ? "border-theme-soft bg-theme-soft text-theme"
                  : "border-amber-400/40 bg-amber-400/10 text-amber-300"
              )}
            >
              {info.replyEnable ? "可互动" : "只读"}
            </Badge>
            <p className="text-muted-foreground">{info.description}</p>
          </div>
        }
        actions={
          <>
            <Button
              asChild
              variant="outline"
              className="border-border bg-card text-foreground hover:bg-accent"
            >
              <Link to={`/community?source=${info.counterpartSource}`}>
                <ArrowLeft className="size-4" />
                前往{info.counterpartLabel}
              </Link>
            </Button>
            <Button size="sm" onClick={startNew}>
              <PenLine className="size-4" />
              发起讨论
            </Button>
          </>
        }
      />

      {/* 工具栏：搜索 + 排序 + 分类分区（主题描边 + 左上柔光） */}
      <div className="community-panel rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 basis-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题或作者…"
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
                热门
              </TabsTrigger>
              <TabsTrigger value="latest" className="gap-1.5">
                <Link2 className="size-3.5 text-sky-400" />
                最新
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
            全部
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
            没有匹配的讨论
          </div>
        ) : (
          pageItems.map((d) => (
            <Link
              key={d.number}
              to={`/community/${d.number}?source=${source ?? "dpc"}`}
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
              {/* 评论数徽章（accent 渐变浸入） */}
              <div className="community-comment-chip flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-3 py-2">
                <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                  <MessagesSquare className="size-3.5 text-theme-accent" />
                  {d.comments}
                </span>
                <span className="text-[10px] text-muted-foreground">评论</span>
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
            上一页
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
            下一页
          </Button>
        </div>
      )}
      </div>
    </>
  )
}
