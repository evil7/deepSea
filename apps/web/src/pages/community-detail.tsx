import { useEffect, useState } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ArrowLeft,
  CornerDownRight,
  ExternalLink,
  Home,
  Loader2,
  MessagesSquare,
  Send,
  SmilePlus,
  User,
} from "lucide-react"
import { Link, useParams } from "react-router-dom"
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
  postDiscussionComment,
  toggleReaction,
  REACTION_CONTENTS,
  REACTION_EMOJI,
  type DiscussionDetail,
  type ReactionGroup,
} from "@/lib/github/discussions"
import { loginUrl } from "@/lib/auth"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
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
    <Avatar size={size} className="border border-white/10 bg-slate-800">
      {url ? <AvatarImage src={url} alt={name} /> : null}
      <AvatarFallback className="bg-slate-800 text-white/45">
        <User className={size === "lg" ? "size-5" : "size-3.5"} />
      </AvatarFallback>
    </Avatar>
  )
}

/** 表情反应条：已有反应 pill + 内联表情选择器（登录后可交互） */
function ReactionBar({
  reactions,
  canInteract,
  onToggle,
}: {
  reactions: ReactionGroup[]
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
                : "border-white/10 bg-slate-800/70 text-white/70 hover:bg-slate-700/70",
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
              : "border-white/15 text-white/45 hover:border-white/30 hover:text-white/80"
          )}
        >
          <SmilePlus className="size-3.5" />
        </button>
      )}

      {/* 内联表情选择器 */}
      {pickerOpen && (
        <div className="flex w-full flex-wrap gap-1 rounded-lg border border-white/10 bg-slate-900/80 p-1.5">
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
                  has ? "bg-cyan-400/15" : "hover:bg-white/10"
                )}
              >
                <span>{REACTION_EMOJI[content]}</span>
                {c > 0 && (
                  <span className="text-[10px] text-white/60">{c}</span>
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
        <div className="rounded-xl border border-white/10 bg-slate-900/70 transition-colors focus-within:border-cyan-400/40">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="写下你的回复…（支持 Markdown）"
            rows={3}
            className="w-full resize-y bg-transparent px-3.5 py-3 text-sm text-white outline-none placeholder:text-white/30"
          />
          <div className="flex items-center justify-between border-t border-white/5 px-3 py-2">
            <span className="font-mono text-[10px] text-white/30">
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

/** 楼帖条目：左侧头像 + timeline 竖线，右侧内容卡片（含表情反应条） */
function PostItem({
  avatarUrl,
  name,
  time,
  floor,
  isOp,
  isAuthor,
  last,
  subjectId,
  reactions,
  canInteract,
  onToggleReaction,
  children,
}: {
  avatarUrl?: string
  name: string
  time: string
  /** 楼层号（OP 不传） */
  floor?: number
  /** OP 主帖（发起者徽章） */
  isOp?: boolean
  /** 评论者是发起者（GitHub 风格 Author 徽章） */
  isAuthor?: boolean
  /** 是否为最后一条（不画竖线） */
  last?: boolean
  /** 表情反应对象 id（discussion / comment 的 node id） */
  subjectId: string
  reactions: ReactionGroup[]
  canInteract: boolean
  onToggleReaction: (subjectId: string, content: string, active: boolean) => void
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      {/* 头像列 + 竖线 */}
      <div className="relative flex shrink-0 flex-col items-center">
        <UserAvatar url={avatarUrl} name={name} />
        {!last && (
          <span
            aria-hidden="true"
            className="mt-2 w-px flex-1 rounded-full bg-white/10"
          />
        )}
      </div>

      {/* 内容 */}
      <div className="min-w-0 flex-1 pb-7">
        {/* 头部：作者 · 徽章 · 时间 · 楼层 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-white">{name}</span>
          {isOp && (
            <Badge className="border-cyan-400/40 bg-cyan-400/10 font-mono text-[10px] text-cyan-300">
              发起者
            </Badge>
          )}
          {isAuthor && (
            <Badge className="border-violet-400/40 bg-violet-400/10 font-mono text-[10px] text-violet-300">
              作者
            </Badge>
          )}
          <span className="text-xs text-white/40">· {time}</span>
          {floor !== undefined && (
            <span className="ml-auto font-mono text-xs text-white/30">
              #{floor}
            </span>
          )}
        </div>

        {/* 内容卡片 */}
        <div
          className={cn(
            "mt-2 rounded-xl border border-white/10 bg-slate-900/70 backdrop-blur-sm transition-colors",
            "hover:border-white/20 hover:bg-slate-900"
          )}
        >
          {children}

          {/* 底部：表情反应条 */}
          <div className="border-t border-white/5 px-4 py-2.5">
            <ReactionBar
              reactions={reactions}
              canInteract={canInteract}
              onToggle={(content, active) =>
                onToggleReaction(subjectId, content, active)
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export function CommunityDetailPage() {
  const { number } = useParams<{ number: string }>()
  const num = Number(number)
  const { user } = useAuth()
  const [detail, setDetail] = useState<DiscussionDetail | null>(null)
  const [state, setState] = useState<"loading" | "unauthorized" | "error" | "ok">(
    "loading"
  )
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let alive = true
    if (!Number.isInteger(num) || num <= 0) {
      setState("error")
      return
    }
    setState("loading")
    loadDiscussionDetail(num).then((d) => {
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
  }, [num])

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

  /** 写操作失败时的降级：提示 + 引导跳转 GitHub */
  const handleWriteFallback = () => {
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
    if (!user) {
      toast.info("请先登录，再表达态度")
      return
    }
    updateReactions(subjectId, content, active)
    const ok = await toggleReaction(subjectId, content, active)
    if (!ok) {
      updateReactions(subjectId, content, !active)
      handleWriteFallback()
    }
  }

  /** 发表回复（成功后追加到评论列表；失败降级跳转 GitHub） */
  const handleSubmitComment = async (body: string) => {
    if (!detail) return
    setSubmitting(true)
    try {
      const comment = await postDiscussionComment(detail.number, detail.id, body)
      if (comment) {
        setDetail((prev) =>
          prev ? { ...prev, comments: [...prev.comments, comment] } : prev
        )
        toast.success("回复已发布")
      } else {
        handleWriteFallback()
      }
    } finally {
      setSubmitting(false)
    }
  }

  // 未登录时先提示（worker 返回 401 → detail 为 null，这里按未登录处理）
  const needsLogin = state === "error" && !user

  return (
    <div className="relative z-10 mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-7xl px-4 py-10 sm:px-6">
      {/* 面包屑（与插件详情页一致） */}
      <nav className="mb-6 flex items-center gap-1.5 text-xs text-white/45">
        <Link
          to="/"
          className="flex items-center gap-1 transition-colors hover:text-white"
        >
          <Home className="size-3.5" />
          首页
        </Link>
        <span>/</span>
        <Link to="/community" className="transition-colors hover:text-white">
          讨论交流
        </Link>
        <span>/</span>
        <span className="font-mono text-white/70">#{num}</span>
      </nav>

      {state === "loading" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <Skeleton className="h-10 w-64 bg-white/5" />
            <Skeleton className="h-4 w-full bg-white/5" />
            <Skeleton className="h-4 w-3/4 bg-white/5" />
            <Skeleton className="h-64 w-full bg-white/5" />
          </div>
          <Skeleton className="h-80 rounded-xl bg-white/5" />
        </div>
      )}

      {needsLogin && (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <MessagesSquare className="size-10 text-white/30" />
          <p className="text-lg font-medium text-white/80">登录后畅聊</p>
          <p className="text-sm text-white/50">
            讨论正文与评论需要 GitHub 授权后才能查看
          </p>
          <Button asChild size="sm" className="mt-2">
            {/* 真实导航：/auth/login 由 Worker 处理，无前端路由 */}
            <a href={loginUrl("/community/" + num)}>
              <User className="size-4" />
              登录
            </a>
          </Button>
        </div>
      )}

      {state === "error" && !needsLogin && (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-lg font-medium text-white/80">出错了</p>
          <p className="text-sm text-white/50">讨论不存在或加载失败</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 border-white/15 bg-slate-900/60 text-white hover:bg-slate-800"
          >
            <ArrowLeft className="size-3.5" />
            <Link to="/community">返回酒馆</Link>
          </Button>
        </div>
      )}

      {detail && state === "ok" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* ── 左栏：楼帖主列（README 风格容器） ── */}
          <main className="min-w-0 rounded-xl border border-white/10 bg-slate-950/70 backdrop-blur-sm">
            {/* 容器头栏 */}
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                <MessagesSquare className="size-4 text-cyan-300" />
                <span className="truncate">讨论 #{detail.number}</span>
                <Badge
                  className={cn(
                    "shrink-0 font-mono text-[10px]",
                    CATEGORY_STYLES[detail.categoryName] ??
                      "border-white/15 bg-white/10 text-white/70"
                  )}
                >
                  {detail.categoryName}
                </Badge>
              </div>
              <a
                href={detail.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-white/45 transition-colors hover:text-white"
              >
                在 GitHub 查看
                <ExternalLink className="size-3" />
              </a>
            </div>

            {/* 容器内容 */}
            <div className="p-4 sm:p-6">
              {/* 标题区 */}
              <header>
                <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  {detail.title}
                </h1>
                {/* 作者行（移动端；桌面端在右侧边栏展示作者卡片） */}
                <div className="mt-4 flex items-center gap-2.5 lg:hidden">
                  <UserAvatar
                    url={detail.authorAvatarUrl}
                    name={detail.author}
                    size="sm"
                  />
                  <div className="text-xs">
                    <p className="font-medium text-white/85">
                      {detail.author}
                    </p>
                    <p className="text-white/40">
                      {formatRelativeTime(detail.createdAt)} 发起 ·{" "}
                      {detail.comments.length} 条评论
                    </p>
                  </div>
                </div>
              </header>

              {/* 楼帖：OP + 评论 timeline */}
              <div className="mt-7">
                <PostItem
                  avatarUrl={detail.authorAvatarUrl}
                  name={detail.author}
                  time={formatRelativeTime(detail.createdAt)}
                  isOp
                  last={detail.comments.length === 0}
                  subjectId={detail.id}
                  reactions={detail.reactions}
                  canInteract={!!user}
                  onToggleReaction={handleToggleReaction}
                >
                  <div
                    className="readme-body markdown-body p-4 sm:p-5"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(
                        renderMarkdown(detail.body),
                        { ADD_ATTR: ["target"] }
                      ),
                    }}
                  />
                </PostItem>

                {/* 评论楼层 */}
                {detail.comments.length === 0 ? (
                  <div className="ml-1 flex items-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-6 text-sm text-white/40">
                    <CornerDownRight className="size-4" />
                    还没有评论，来抢沙发
                  </div>
                ) : (
                  detail.comments.map((c, i) => (
                    <PostItem
                      key={c.id}
                      avatarUrl={c.avatarUrl}
                      name={c.author}
                      time={formatRelativeTime(c.createdAt)}
                      floor={i + 1}
                      isAuthor={c.author === detail.author}
                      last={i === detail.comments.length - 1}
                      subjectId={c.id}
                      reactions={c.reactions}
                      canInteract={!!user}
                      onToggleReaction={handleToggleReaction}
                    >
                      <div
                        className="readme-body markdown-body p-4"
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(
                            renderMarkdown(c.body),
                            { ADD_ATTR: ["target"] }
                          ),
                        }}
                      />
                    </PostItem>
                  ))
                )}

                {/* 站内回复编辑器（登录后可用） */}
                <div className="mt-2 ml-12">
                  {user ? (
                    <ReplyEditor
                      avatarUrl={user.avatar_url}
                      name={user.login}
                      submitting={submitting}
                      onSubmit={handleSubmitComment}
                    />
                  ) : (
                    <div className="flex items-center justify-between rounded-xl border border-dashed border-white/15 px-4 py-4 text-sm text-white/45">
                      <span>登录后即可参与回复</span>
                      <Button asChild size="sm" variant="outline">
                        <a href={loginUrl("/community/" + num)}>
                          <User className="size-4" />
                          登录
                        </a>
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </main>

          {/* ── 右栏：边栏（sticky 固定，滚动不消失；与插件详情页一致） ── */}
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            {/* 作者卡片 */}
            <div className="rounded-xl border border-white/10 bg-slate-900/70 p-5 backdrop-blur-sm">
              <div className="flex items-center gap-3">
                <UserAvatar url={detail.authorAvatarUrl} name={detail.author} />
                <div className="min-w-0">
                  <p className="truncate font-medium text-white">
                    {detail.author}
                  </p>
                  <p className="text-xs text-white/45">
                    {formatRelativeTime(detail.createdAt)} 发起
                  </p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs text-white/45">
                <MessagesSquare className="size-3.5 text-cyan-300/80" />
                讨论 #{detail.number} · {detail.comments.length} 条评论
              </div>
            </div>

            {/* 统计（评论数 / 最近更新） */}
            <div className="rounded-xl border border-white/10 bg-slate-900/70 p-5 backdrop-blur-sm">
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-lg bg-white/5 py-3">
                  <p className="text-lg font-semibold text-white">
                    {detail.comments.length}
                  </p>
                  <p className="text-xs text-white/45">评论</p>
                </div>
                <div className="rounded-lg bg-white/5 py-3">
                  <p className="text-sm font-semibold text-white">
                    {formatRelativeTime(detail.updatedAt)}
                  </p>
                  <p className="text-xs text-white/45">最近更新</p>
                </div>
              </div>
            </div>

            {/* 分类 */}
            <div className="rounded-xl border border-white/10 bg-slate-900/70 p-5 backdrop-blur-sm">
              <p className="font-mono text-[10px] tracking-[0.25em] text-white/40">
                CATEGORY
              </p>
              <div className="mt-3">
                <Badge
                  className={cn(
                    "font-mono text-[11px]",
                    CATEGORY_STYLES[detail.categoryName] ??
                      "border-white/15 bg-white/10 text-white/70"
                  )}
                >
                  {detail.categoryName}
                </Badge>
              </div>
            </div>

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
  )
}

/** 渲染 markdown → HTML（GFM + raw HTML，供 DOMPurify 消毒后注入） */
function renderMarkdown(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
      {md}
    </ReactMarkdown>
  )
}
