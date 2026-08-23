import { useEffect, useMemo, useState } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  CornerDownRight,
  ExternalLink,
  Home,
  Loader2,
  MessagesSquare,
  Send,
  SmilePlus,
  User,
} from "lucide-react"
import { Link, useLocation, useParams } from "react-router-dom"
import DOMPurify from "dompurify"
import ReactMarkdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import remarkGfm from "remark-gfm"
import "github-markdown-css/github-markdown-dark.css"
import { toast } from "sonner"

import { useAuth } from "@/hooks/use-auth"
import {
  formatRelativeTime,
  loadDiscussionDetail,
  loadOfficialDiscussionDetail,
  postDiscussionComment,
  resolveCommunity,
  toggleReaction,
  REACTION_CONTENTS,
  REACTION_EMOJI,
  type DiscussionComment,
  type DiscussionDetail,
  type ReactionGroup,
  type WriteFailure,
} from "@/lib/github/discussions"
import { useAuthHrefs } from "@/hooks/use-auth-hrefs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { usePageEnter } from "@/components/showcase/page-enter"
import { PageHeader } from "@/components/layout/page-header"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// /community/:number —— 讨论详情（讨论交流 · 楼帖 + 站内回复 + 表情反应）
//   需登录（前端 octokit GraphQL 直调 GitHub API，见 lib/github/discussions.ts）
//   复刻 GitHub Discussion 布局，融入杂志式两栏设计：
//   · 左栏主列：OP 主帖 + 评论楼层（头像 timeline、楼层号、作者徽章）
//   · 每帖底部：表情反应条（emoji pill + 表情选择器）+ 站内回复编辑器
//   · 右栏边栏：作者卡片 / 统计 / 分类 / 参与讨论（sticky）
//   · markdown 渲染（GFM + raw，DOMPurify 消毒）；头像缺失用 User 图标兜底
// ---------------------------------------------------------------------------

const CATEGORY_STYLES: Record<string, string> = {
  Announcements: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  General: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  Ideas: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  "Q&A": "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  "Show and tell": "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  Polls: "border-rose-400/30 bg-rose-400/10 text-rose-300",
}

/** 头像：URL 非空才渲染 img，否则 User 图标 fallback（避免空 src 警告） */
function UserAvatar({
  url,
  name,
  size = "lg",
}: {
  url?: string
  name: string
  size?: "default" | "sm" | "lg"
}) {
  return (
    <Avatar size={size} className="border border-border bg-muted">
      {url ? <AvatarImage src={url} alt={name} /> : null}
      <AvatarFallback className="bg-muted text-muted-foreground">
        <User className={size === "lg" ? "size-5" : "size-3.5"} />
      </AvatarFallback>
    </Avatar>
  )
}

/** 表情反应条：投票数（最前）+ 已有反应 pill + 内联表情选择器（登录后可交互） */
function ReactionBar({
  reactions,
  upvoteCount = 0,
  canInteract,
  onToggle,
}: {
  reactions: ReactionGroup[]
  /** 投票数（帖子与评论均独立持有） */
  upvoteCount?: number
  canInteract: boolean
  onToggle: (content: string, active: boolean) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  const reacted = (content: string) =>
    reactions.find((r) => r.content === content)?.viewerHasReacted ?? false
  const countOf = (content: string) =>
    reactions.find((r) => r.content === content)?.count ?? 0

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* 投票数：最前第一个（帖/评论各自持有） */}
      <span className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        <ArrowUp className="size-3" />
        <span className="font-mono">{upvoteCount}</span>
      </span>

      {/* 已有反应 */}
      {reactions
        .filter((r) => r.count > 0)
        .map((r) => (
          <button
            key={r.content}
            type="button"
            disabled={!canInteract}
            onClick={() => onToggle(r.content, !r.viewerHasReacted)}
            title={r.content}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
              r.viewerHasReacted
                ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200"
                : "border-border bg-muted text-muted-foreground hover:bg-accent",
              canInteract ? "cursor-pointer" : "cursor-default"
            )}
          >
            <span className="text-sm leading-none">
              {REACTION_EMOJI[r.content] ?? r.content}
            </span>
            <span className="font-mono">{r.count}</span>
          </button>
        ))}

      {/* 表情选择器按钮 */}
      {canInteract && (
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="添加表情"
          aria-expanded={pickerOpen}
          className={cn(
            "flex items-center rounded-full border border-dashed px-1.5 py-0.5 text-xs transition-colors",
            pickerOpen
              ? "border-cyan-400/50 text-cyan-200"
              : "border-border text-muted-foreground hover:border-border hover:text-foreground"
          )}
        >
          <SmilePlus className="size-3.5" />
        </button>
      )}

      {/* 内联表情选择器 */}
      {pickerOpen && (
        <div className="flex w-full flex-wrap gap-1 rounded-lg border border-border bg-card p-1.5">
          {REACTION_CONTENTS.map((content) => {
            const c = countOf(content)
            const has = reacted(content)
            return (
              <button
                key={content}
                type="button"
                onClick={() => onToggle(content, !has)}
                title={content}
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-1 text-base transition-colors",
                  has ? "bg-cyan-400/15" : "hover:bg-accent"
                )}
              >
                <span>{REACTION_EMOJI[content]}</span>
                {c > 0 && (
                  <span className="text-[10px] text-muted-foreground">{c}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 站内回复编辑器（登录后可用；复刻 GitHub 评论框） */
function ReplyEditor({
  avatarUrl,
  name,
  submitting,
  onSubmit,
}: {
  avatarUrl?: string
  name: string
  submitting: boolean
  onSubmit: (body: string) => void
}) {
  const [text, setText] = useState("")
  const canSubmit = text.trim().length > 0 && !submitting

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit(text.trim())
    setText("")
  }

  return (
    <div className="flex gap-3">
      <UserAvatar url={avatarUrl} name={name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="rounded-xl border border-border bg-card transition-colors focus-within:border-cyan-400/40">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="且慢，我有话要说…"
            rows={3}
            className="w-full resize-y bg-transparent px-3.5 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">
              Markdown 语法支持
            </span>
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="gap-1.5"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              评论
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 评论排序方式（作用于顶层评论；子回复恒按时间正序） */
type SortMode = "oldest" | "newest" | "top"

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "oldest", label: "Oldest" },
  { value: "newest", label: "Newest" },
  { value: "top", label: "Top" },
]

/** 评论树节点（含已排序子回复） */
interface CommentNode {
  comment: DiscussionComment
  depth: number
  children: CommentNode[]
}

/** 最大视觉缩进层级：更深层回复不再继续缩进，避免内容被压扁 */
const MAX_VISUAL_DEPTH = 3

/**
 * 构建评论树：按 replyToId 挂子回复；顶层按 sortMode 排序，
 * 子回复恒按时间正序（自然对话顺序）。
 */
/** 按时间正序排序（子回复对话顺序，恒正序） */
function sortByTimeAsc(list: DiscussionComment[]): DiscussionComment[] {
  return list.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function buildCommentTree(
  comments: DiscussionComment[],
  sortMode: SortMode
): CommentNode[] {
  const byId = new Map<string, DiscussionComment>()
  for (const c of comments) byId.set(c.id, c)

  const childrenOf = new Map<string, DiscussionComment[]>()
  const roots: DiscussionComment[] = []
  for (const c of comments) {
    if (c.replyToId && byId.has(c.replyToId)) {
      const arr = childrenOf.get(c.replyToId) ?? []
      arr.push(c)
      childrenOf.set(c.replyToId, arr)
    } else {
      roots.push(c)
    }
  }

  const sortRoots = (list: DiscussionComment[]) => {
    if (sortMode === "newest") {
      return list.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    }
    if (sortMode === "top") {
      return list.toSorted(
        (a, b) =>
          b.upvoteCount - a.upvoteCount ||
          b.createdAt.localeCompare(a.createdAt)
      )
    }
    return list.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  const build = (c: DiscussionComment, depth: number): CommentNode => ({
    comment: c,
    depth,
    children: sortByTimeAsc(childrenOf.get(c.id) ?? []).map((ch) =>
      build(ch, depth + 1)
    ),
  })

  return sortRoots(roots).map((r) => build(r, 0))
}

/**
 * 单条评论（递归渲染其子回复）
 * 树状层级：depth 1~3 每层「缩进 + 左侧竖线」，更深层不再缩进（防压扁）；
 * 回复他人时显示「回复 @xxx」引用；被采纳显示「已采纳答案」徽章。
 */
function CommentItem({
  node,
  discussionAuthor,
  canInteract,
  onToggleReaction,
}: {
  node: CommentNode
  discussionAuthor: string
  canInteract: boolean
  onToggleReaction: (subjectId: string, content: string, active: boolean) => void
}) {
  const { comment, depth, children } = node
  const indented = depth > 0 && depth <= MAX_VISUAL_DEPTH

  return (
    <div
      className={cn(
        indented && "relative ml-6 border-l-2 border-border pl-4 sm:ml-8 sm:pl-5"
      )}
    >
      <div className="flex gap-3">
        {/* 头像（子回复用更小尺寸，降低视觉重量） */}
        <div className="shrink-0 pt-0.5">
          <UserAvatar
            url={comment.avatarUrl}
            name={comment.author}
            size={indented ? "sm" : "lg"}
          />
        </div>

        {/* 内容 */}
        <div className="min-w-0 flex-1 pb-5">
          {/* 头部：作者 · 徽章 · 时间 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-foreground">
              {comment.author}
            </span>
            {comment.author === discussionAuthor && (
              <Badge className="border-violet-400/40 bg-violet-400/10 font-mono text-[10px] text-violet-300">
                作者
              </Badge>
            )}
            {comment.isAnswer && (
              <Badge className="border-emerald-400/40 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">
                <CheckCircle2 className="mr-1 size-3" />
                已采纳答案
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              · {formatRelativeTime(comment.createdAt)}
            </span>
          </div>

          {/* 回复引用（回复他人时显示） */}
          {comment.replyToAuthor && (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <CornerDownRight className="size-3" />
              回复
              <span className="font-medium text-cyan-300">
                @{comment.replyToAuthor}
              </span>
            </div>
          )}

          {/* 内容卡片 */}
          <div className="mt-2 rounded-xl border border-border bg-card">
            <div
              className="readme-body markdown-body p-4"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(renderMarkdown(comment.body), {
                  ADD_ATTR: ["target"],
                }),
              }}
            />
            <div className="border-t border-border px-4 py-2.5">
              <ReactionBar
                reactions={comment.reactions}
                upvoteCount={comment.upvoteCount}
                canInteract={canInteract}
                onToggle={(content, active) =>
                  onToggleReaction(comment.id, content, active)
                }
              />
            </div>
          </div>
        </div>
      </div>

      {/* 子回复递归 */}
      {children.map((child) => (
        <CommentItem
          key={child.comment.id}
          node={child}
          discussionAuthor={discussionAuthor}
          canInteract={canInteract}
          onToggleReaction={onToggleReaction}
        />
      ))}
    </div>
  )
}

export function CommunityDetailPage() {
  const { number } = useParams<{ number: string }>()
  // 社区来源：/community/dsh/:number（蓝鲸社区，只读）| /community/dpc/:number（浪尖酒馆）
  // 路由 source 段为静态段，需从 pathname 解析
  const { pathname } = useLocation()
  const source = pathname.split("/")[2] === "dsh" ? "dsh" : "dpc"
  const num = Number(number)
  const { user } = useAuth()
  const { loginHref } = useAuthHrefs()
  // 社区来源：/community/dsh/:number（蓝鲸社区，只读）| /community/dpc/:number（浪尖酒馆）
  const info = useMemo(() => resolveCommunity(source), [source])
  const [detail, setDetail] = useState<DiscussionDetail | null>(null)
  const [state, setState] = useState<"loading" | "unauthorized" | "error" | "ok">(
    "loading"
  )
  const [submitting, setSubmitting] = useState(false)
  // 评论排序方式（默认 oldest = 时间正序，符合「时间线」语义）
  const [sortMode, setSortMode] = useState<SortMode>("oldest")

  // 是否可回复：由 discussion 实际状态动态判定（非硬编码社区开关）
  // 管理员锁定（locked）或关闭（closed）的讨论均不可回复
  const canReply = !!detail && !detail.locked && !detail.closed

  // 评论树（按排序方式构建；子回复恒按时间正序）
  const commentTree = useMemo(
    () => (detail ? buildCommentTree(detail.comments, sortMode) : []),
    [detail, sortMode]
  )

  useEffect(() => {
    let alive = true
    if (!Number.isInteger(num) || num <= 0) {
      setState("error")
      return
    }
    setState("loading")
    const loadDetail =
      info.source === "dsh"
        ? loadOfficialDiscussionDetail
        : loadDiscussionDetail
    loadDetail(num).then((d) => {
      if (!alive) return
      if (!d) {
        // 区分未登录（401）与其他错误
        setState("error")
        return
      }
      setDetail(d)
      setState("ok")
    })
    return () => {
      alive = false
    }
  }, [num, info.source])

  /** 乐观更新某个 subjectId（discussion / comment）的表情反应 */
  const updateReactions = (
    subjectId: string,
    content: string,
    active: boolean
  ) => {
    setDetail((prev) => {
      if (!prev) return prev
      const apply = (list: ReactionGroup[]): ReactionGroup[] => {
        const existing = list.find((r) => r.content === content)
        if (active) {
          if (existing) {
            return list.map((r) =>
              r.content === content
                ? { ...r, count: r.count + 1, viewerHasReacted: true }
                : r
            )
          }
          return [...list, { content, count: 1, viewerHasReacted: true }]
        }
        // 移除
        if (!existing) return list
        const nextCount = existing.count - 1
        if (nextCount <= 0) return list.filter((r) => r.content !== content)
        return list.map((r) =>
          r.content === content
            ? { ...r, count: nextCount, viewerHasReacted: false }
            : r
        )
      }

      if (prev.id === subjectId) {
        return { ...prev, reactions: apply(prev.reactions) }
      }
      return {
        ...prev,
        comments: prev.comments.map((c) =>
          c.id === subjectId ? { ...c, reactions: apply(c.reactions) } : c
        ),
      }
    })
  }

  /** 写操作失败时的降级：按失败原因针对性提示 + 引导跳转 GitHub */
  const handleWriteFallback = (failure?: WriteFailure) => {
    if (failure?.kind === "forbidden") {
      toast.error("没有写入权限", {
        description: "该讨论所在组织限制了第三方应用的写入权限，请在 GitHub 上操作",
        action: {
          label: "前往 GitHub",
          onClick: () =>
            detail && window.open(detail.url, "_blank", "noopener,noreferrer"),
        },
      })
      return
    }
    if (failure?.kind === "rate_limited") {
      toast.error("触发 GitHub 限流", {
        description: "操作过于频繁，请稍后再试",
      })
      return
    }
    toast.error("操作未成功", {
      description: "可在 GitHub 上完成该操作",
      action: {
        label: "前往 GitHub",
        onClick: () =>
          detail && window.open(detail.url, "_blank", "noopener,noreferrer"),
      },
    })
  }

  /** 切换表情反应（乐观更新 + 失败回滚） */
  const handleToggleReaction = async (
    subjectId: string,
    content: string,
    active: boolean
  ) => {
    if (!canReply) {
      toast.info("该讨论已锁定或关闭，无法表态")
      return
    }
    if (!user) {
      toast.info("请先登录，再表达态度")
      return
    }
    updateReactions(subjectId, content, active)
    const result = await toggleReaction(subjectId, content, active)
    if (!result.ok) {
      updateReactions(subjectId, content, !active)
      handleWriteFallback(result.failure)
    }
  }

  /** 发表回复（成功后追加到评论列表；失败降级跳转 GitHub） */
  const handleSubmitComment = async (body: string) => {
    if (!detail || !canReply) return
    setSubmitting(true)
    try {
      const { comment, failure } = await postDiscussionComment(
        detail.number,
        detail.id,
        body
      )
      if (comment) {
        setDetail((prev) =>
          prev ? { ...prev, comments: [...prev.comments, comment] } : prev
        )
        toast.success("回复已发布")
      } else {
        handleWriteFallback(failure)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // 未登录时先提示（worker 返回 401 → detail 为 null，这里按未登录处理）
  const needsLogin = state === "error" && !user

  const pageRef = usePageEnter<HTMLDivElement>()

  return (
    <>
      <style>{COMMUNITY_MARKDOWN_CSS}</style>
      <div
        ref={pageRef}
        className="relative z-10 mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-7xl px-4 py-10 sm:px-6"
      >
      {/* 页头：面包屑 + 讨论编号（共享 PageHeader） */}
      <PageHeader
        breadcrumb={
          <>
            <Link
              to="/"
              className="flex items-center gap-1 transition-colors hover:text-foreground"
            >
              <Home className="size-3.5" />
              首页
            </Link>
            <span>/</span>
            <Link
              to={`/community/${info.source}`}
              className="transition-colors hover:text-foreground"
            >
              {info.label}
            </Link>
          </>
        }
        title={
          detail ? (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{detail.title}</span>
              <span className="shrink-0 font-mono text-base font-normal text-muted-foreground">
                #{num}
              </span>
            </span>
          ) : (
            // 数据加载前用占位骨架，避免把「# 编号」当临时标题映射
            <Skeleton className="h-8 w-72 bg-muted" />
          )
        }
      />

      {state === "loading" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <Skeleton className="h-10 w-64 bg-muted" />
            <Skeleton className="h-4 w-full bg-muted" />
            <Skeleton className="h-4 w-3/4 bg-muted" />
            <Skeleton className="h-64 w-full bg-muted" />
          </div>
          <Skeleton className="h-80 rounded-xl bg-muted" />
        </div>
      )}

      {needsLogin && (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <MessagesSquare className="size-10 text-muted-foreground" />
          <p className="text-lg font-medium text-foreground">登录后畅聊</p>
          <p className="text-sm text-muted-foreground">
            讨论正文与评论需要 GitHub 授权后才能查看
          </p>
          <Button asChild size="sm" className="mt-2">
            {/* 真实导航：/auth/login 由 Worker 处理，无前端路由 */}
            <a href={loginHref}>
              <User className="size-4" />
              登录
            </a>
          </Button>
        </div>
      )}

      {state === "error" && !needsLogin && (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-lg font-medium text-foreground">出错了</p>
          <p className="text-sm text-muted-foreground">讨论不存在或加载失败</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 border-border bg-card text-foreground hover:bg-accent"
          >
            <ArrowLeft className="size-3.5" />
            <Link to={`/community/${info.source}`}>返回{info.label}</Link>
          </Button>
        </div>
      )}

      {detail && state === "ok" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* ── 左栏：主贴卡片 + 评论卡片（两卡片分离） ── */}
          <main className="min-w-0 space-y-6">
            {/* 主贴卡片（OP 独立卡片，标题已上移到页头） */}
            <section className="rounded-xl border border-border bg-card">
              {/* 卡片头：左作者信息 / 右分类标签 + 在 GitHub 查看 */}
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <UserAvatar url={detail.authorAvatarUrl} name={detail.author} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {detail.author}
                      </span>
                      <Badge className="border-cyan-400/40 bg-cyan-400/10 font-mono text-[10px] text-cyan-300">
                        发起者
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatRelativeTime(detail.createdAt)} 发起
                    </p>
                  </div>
                </div>

                <a
                  href={detail.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  在 GitHub 查看
                  <ExternalLink className="size-3" />
                </a>
              </div>

              <div
                className="readme-body markdown-body p-5 sm:p-6"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(renderMarkdown(detail.body), {
                    ADD_ATTR: ["target"],
                  }),
                }}
              />

              <div className="border-t border-border px-5 py-2.5">
                <ReactionBar
                  reactions={detail.reactions}
                  upvoteCount={detail.upvoteCount}
                  canInteract={!!user && canReply}
                  onToggle={(content, active) =>
                    handleToggleReaction(detail.id, content, active)
                  }
                />
              </div>
            </section>

            {/* 评论 bar：{n} comments（左）+ outline 排序 tabs（右），左右分布 */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
              <span className="text-sm font-medium text-foreground">
                {detail.commentTotalCount} comments
              </span>
              <div className="flex items-center gap-1">
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSortMode(opt.value)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                      sortMode === opt.value
                        ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                        : "border-border text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 回复内容平展（每条独立，不套大卡片） */}
            {commentTree.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                <CornerDownRight className="size-4" />
                还没有评论，来抢沙发
              </div>
            ) : (
              <div className="space-y-4">
                {commentTree.map((node) => (
                  <CommentItem
                    key={node.comment.id}
                    node={node}
                    discussionAuthor={detail.author}
                    canInteract={!!user && canReply}
                    onToggleReaction={handleToggleReaction}
                  />
                ))}
              </div>
            )}

            {/* 回复编辑器（登录 + 未锁定且开放时可用） */}
            <div className="mt-2">
              {!canReply ? (
                <div className="flex items-center justify-between rounded-xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
                  <span>
                    {detail.locked
                      ? "该讨论已被管理员锁定，无法回复"
                      : detail.closed
                      ? "该讨论已关闭，无法回复"
                      : "当前无法回复"}
                  </span>
                  <Button asChild size="sm" variant="outline">
                    <a href={detail.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-4" />
                      前往 GitHub 参与
                    </a>
                  </Button>
                </div>
              ) : user ? (
                <ReplyEditor
                  avatarUrl={user.avatar_url}
                  name={user.login}
                  submitting={submitting}
                  onSubmit={handleSubmitComment}
                />
              ) : (
                <div className="flex items-center justify-between rounded-xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
                  <span>登录后即可参与回复</span>
                  <Button asChild size="sm" variant="outline">
                    <a href={loginHref}>
                      <User className="size-4" />
                      登录
                    </a>
                  </Button>
                </div>
              )}
            </div>
          </main>

          {/* ── 右栏：边栏（sticky 固定，滚动不消失；与插件详情页一致） ── */}
          <aside className="space-y-4 lg:sticky lg:top-34.5 lg:self-start">
            {/* 作者卡片（3 行：头像占前两行 / 名字 / 时间 / 评论数+投票数） */}
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <UserAvatar url={detail.authorAvatarUrl} name={detail.author} />
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {detail.author}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatRelativeTime(detail.createdAt)} 发起 · 最新更新{" "}
                    {formatRelativeTime(detail.updatedAt)}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <MessagesSquare className="size-3.5 text-cyan-300/80" />
                  {detail.commentTotalCount} 条评论
                </span>
                <span className="flex items-center gap-1.5">
                  <ArrowUp className="size-3.5 text-cyan-300/80" />
                  {detail.upvoteCount} 个投票
                </span>
              </div>
            </div>

            {/* 分类 */}
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground">
                CATEGORY
              </p>
              <div className="mt-3">
                <Badge
                  className={cn(
                    "font-mono text-[11px]",
                    CATEGORY_STYLES[detail.categoryName] ??
                      "border-border bg-accent text-foreground"
                  )}
                >
                  {detail.categoryName}
                </Badge>
              </div>
            </div>

            {/* 发起人的其他帖子（若有则列举最近 10 条） */}
            {detail.authorPosts.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground">
                  MORE DISCUSSIONS
                </p>
                <ul className="mt-3 space-y-0.5">
                  {detail.authorPosts.map((p) => (
                    <li key={p.number}>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent"
                      >
                        <span className="shrink-0 font-mono text-muted-foreground group-hover:text-foreground">
                          #{p.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {p.title}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* GitHub 参与 */}
            <Button asChild className="w-full">
              <a href={detail.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" />
                在 GitHub 参与讨论
              </a>
            </Button>
          </aside>
        </div>
      )}
      </div>
    </>
  )
}

/** 社区 markdown 覆盖样式：背景透明融入卡片圆角（github-markdown-css dark 为 #0d1117 实底） */
const COMMUNITY_MARKDOWN_CSS = `
  .readme-body.markdown-body {
    background-color: transparent;
    font-family: inherit;
    font-size: 14px;
    line-height: 1.7;
  }
  .readme-body.markdown-body a { color: #67e8f9; }
  .readme-body.markdown-body a:hover { color: #a5f3fc; }
  .readme-body.markdown-body img { display: inline; vertical-align: baseline; height: auto; }
  .readme-body.markdown-body pre { background-color: rgba(2, 6, 23, 0.9); }
`

/** 渲染 markdown → HTML（GFM + raw HTML，供 DOMPurify 消毒后注入） */
function renderMarkdown(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
      {md}
    </ReactMarkdown>
  )
}
