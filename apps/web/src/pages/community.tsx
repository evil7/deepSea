import { useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  ExternalLink,
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
  type DiscussionSummary,
} from "@/lib/github/discussions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  // 社区来源：?source=own（默认，可互动）| official（只读）；replyEnable 控制回复
  const source = searchParams.get("source")
  const info = useMemo(() => resolveCommunity(source), [source])
  // replyEnable：URL 显式参数优先，未传时用 source 兜底（official 默认 false）
  const replyEnableParam = searchParams.get("replyEnable")
  const replyEnable =
    replyEnableParam === null ? info.replyEnable : replyEnableParam !== "false"
  const [list, setList] = useState<DiscussionSummary[] | null>(null)
  const [mode, setMode] = useState<SortMode>("hot")
  const [category, setCategory] = useState<CategoryFilter>("ALL")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  // 分类：登录后取 GitHub 真实分类（含 id）；匿名从 seed 数据推导
  const [categories, setCategories] = useState<string[]>([])

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

  // 登录后拉取 GitHub 真实分类（仅我们的社区；官方社区从 seed 推导）
  useEffect(() => {
    if (!user || info.source === "official") {
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

  // 官方社区 / 未登录时：从 seed 数据推导真实分类
  useEffect(() => {
    if (!list) {
      return
    }
    if (info.source === "official" || !user) {
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
    <div className="mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-7xl px-4 py-10 sm:px-6">
      {/* 页头：标题 + 发起讨论 */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-[0.3em] text-cyan-300/90">
            04 · COMMUNITY
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {info.label}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {info.source === "official"
              ? "DeepSeek Harness 官方讨论（只读）—— 内容实时同步，站内仅浏览。"
              : "深海的自家酒馆，畅聊插件、Q&A 与创意 —— 回复与表态都从这里开始。"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {info.source === "official" ? (
            <Button
              asChild
              variant="outline"
              className="border-border bg-card text-foreground hover:bg-accent"
            >
              <Link to="/community?source=own">
                <ArrowLeft className="size-4" />
                返回我们的社区
              </Link>
            </Button>
          ) : (
            <>
              {/* 官方社区：只读 + 跳转链接 */}
              <Button
                asChild
                variant="outline"
                className="border-border bg-card text-foreground hover:bg-accent"
              >
                <a
                  href="https://github.com/deepseek-ai/deepseek-harness/discussions"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4" />
                  官方社区（只读）
                </a>
              </Button>
              <Button size="sm" onClick={startNew}>
                <PenLine className="size-4" />
                发起讨论
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 工具栏：搜索 + 排序 + 分类分区（毛玻璃卡片容器，与 plugins 页筛选区一致） */}
      <div className="mt-6 rounded-xl border border-border bg-card p-4">
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
                ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200"
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
                    ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200"
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
          <div className="rounded-lg border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            没有匹配的讨论
          </div>
        ) : (
          pageItems.map((d) => (
            <Link
              key={d.number}
              to={`/community/${d.number}?source=${source ?? "own"}&replyEnable=${replyEnable}`}
              className="group flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-cyan-400/40 hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
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
                  <span className="font-mono text-xs text-muted-foreground">
                    #{d.number}
                  </span>
                </div>
                <p className="mt-1.5 truncate text-sm font-medium text-foreground transition-colors group-hover:text-cyan-200">
                  {d.title}
                </p>
                <p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <AuthorAvatar url={d.avatarUrl} name={d.author} />
                  <span className="text-foreground/80">{d.author}</span>
                  <span>·</span>
                  {formatRelativeTime(d.updatedAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <MessagesSquare className="size-3.5" />
                {d.comments}
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
  )
}
