import { useEffect, useMemo, useState } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  CornerDownRight,
  ExternalLink,
  Eye,
  EyeOff,
  Home,
  Loader2,
  MessagesSquare,
  Send,
  SmilePlus,
  ThumbsDown,
  User,
} from "lucide-react"
import { Link, useLocation, useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import DOMPurify from "dompurify"
import ReactMarkdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import remarkGfm from "remark-gfm"
import "github-markdown-css/github-markdown.css"
import { toast } from "sonner"

import { useAuth } from "@/hooks/use-auth"
import { useCommunityBlocks } from "@/hooks/use-community-blocks"
import { BlockedNotice } from "@/components/community/blocked-notice"
import { BlockUserButton } from "@/components/community/block-user-button"
import {
  resolveBlockReason,
  thumbsDownCount,
  type CommunityBlocks,
} from "@/lib/community-blocks"
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
import { usePageMeta } from "@/hooks/use-page-meta"
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
  const { t } = useTranslation()
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
          aria-label={t("communityDetail.addReaction")}
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
  const { t } = useTranslation()
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
            placeholder={t("communityDetail.replyPlaceholder")}
            rows={3}
            className="w-full resize-y bg-transparent px-3.5 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">
              {t("communityDetail.markdownSupported")}
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
              {t("communityDetail.comment")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 评论排序方式（作用于顶层评论；子回复恒按时间正序） */
type SortMode = "oldest" | "newest" | "top"

const SORT_OPTIONS: {
  value: SortMode
  labelKey: "communityDetail.sortOldest" | "communityDetail.sortNewest" | "communityDetail.sortTop"
}[] = [
  { value: "oldest", labelKey: "communityDetail.sortOldest" },
  { value: "newest", labelKey: "communityDetail.sortNewest" },
  { value: "top", labelKey: "communityDetail.sortTop" },
]

/** 评论树节点：顶层评论（已按 sortMode 排序）+ 时间正序的嵌套回复 */
interface CommentNode {
  comment: DiscussionComment
  replies: DiscussionComment[]
}

/** 按时间正序排序（子回复对话顺序，恒正序） */
function sortByTimeAsc(list: DiscussionComment[]): DiscussionComment[] {
  return list.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * 构建评论树：顶层评论按 sortMode 排序，嵌套回复（来自 GraphQL replies
 * 连接）恒按时间正序（自然对话顺序）。GitHub 回复为两层结构（评论 → 回复），
 * 回复不再嵌套，因此无需递归深度。
 */
function buildCommentTree(
  comments: DiscussionComment[],
  sortMode: SortMode
): CommentNode[] {
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
  return sortRoots(comments).map((c) => ({
    comment: c,
    replies: sortByTimeAsc(c.replies),
  }))
}

/**
 * 单条回复（评论卡片内「回复板块」的一行，GitHub 官方回复样式）
 * 竖向 steps 串联：左侧头像列（小头像节点 + 贯穿竖线，最后一条无竖线），
 * 右侧内容（作者/时间/正文/反应条）。回复无边框卡片，弱于评论形成层级区分。
 */
function ReplyRow({
  reply,
  discussionAuthor,
  canInteract,
  onToggleReaction,
  isLast,
  blocks,
}: {
  reply: DiscussionComment
  discussionAuthor: string
  canInteract: boolean
  onToggleReaction: (subjectId: string, content: string, active: boolean) => void
  /** 是否为板块内最后一条回复（决定竖线是否贯穿到底） */
  isLast: boolean
  /** 社区软屏蔽偏好（用户屏蔽 / 踩贴过滤） */
  blocks: CommunityBlocks
}) {
  const { t } = useTranslation()
  // 软屏蔽判定：命中且 hide 模式 → 整条不渲染；collapse 模式 → 折叠提示条
  const reason = resolveBlockReason(blocks, {
    author: reply.author,
    reactions: reply.reactions,
  })
  const [expanded, setExpanded] = useState(false)

  if (reason && blocks.mode === "hide") return null

  return (
    <div className={cn(!isLast && "pb-3")}>
      {/* 低质横幅常驻：提供展开 / 再次折叠 */}
      {reason && (
        <BlockedNotice
          open={expanded}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
      {(expanded || !reason) && (
        <div className="flex gap-3">
      {/* 头像列：头像节点 + 竖向连接线（steps 主干） */}
      <div className="flex shrink-0 flex-col items-center">
        <UserAvatar url={reply.avatarUrl} name={reply.author} size="sm" />
        {!isLast && <div className="mt-1.5 w-px flex-1 bg-border/70" />}
      </div>

      {/* 内容 */}
      <div className={cn("min-w-0 flex-1", !isLast && "pb-5")}>
        {/* 头部：作者 · 徽章 · 时间 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-foreground">
            {reply.author}
          </span>
          {reply.author === discussionAuthor && (
            <Badge className="border-violet-400/40 bg-violet-400/10 font-mono text-[10px] text-violet-300">
              {t("communityDetail.authorBadge")}
            </Badge>
          )}
          {reply.isAnswer && (
            <Badge className="border-emerald-400/40 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">
              <CheckCircle2 className="mr-1 size-3" />
              {t("communityDetail.answerBadge")}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            · {formatRelativeTime(reply.createdAt)}
          </span>
          {/* 用户屏蔽快捷按钮 */}
          <BlockUserButton login={reply.author} size="icon" />
        </div>

        {/* 回复引用（回复他人时显示） */}
        {reply.replyToAuthor && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <CornerDownRight className="size-3" />
            {t("communityDetail.reply")}
            <span className="font-medium text-cyan-300">
              @{reply.replyToAuthor}
            </span>
          </div>
        )}

        {/* 正文（无边框扁平，弱于评论卡片） */}
        <div
          className="readme-body markdown-body mt-1.5"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(renderMarkdown(reply.body), {
              ADD_ATTR: ["target"],
            }),
          }}
        />

        {/* 反应条（虚线分隔，轻量） */}
        <div className="mt-1.5 border-t border-dashed border-border/60 pt-1.5">
          <ReactionBar
            reactions={reply.reactions}
            upvoteCount={reply.upvoteCount}
            canInteract={canInteract}
            onToggle={(content, active) =>
              onToggleReaction(reply.id, content, active)
            }
          />
        </div>
      </div>
      </div>
      )}
    </div>
  )
}

/**
 * 低质帖大卡片横幅：帖子（OP）命中低质判定时，整个帖子（含评论/回复）折叠
 * 成占位卡片。居中大 👎 icon + 低质贴 + 被踩次数 + 「偏要浅尝狗屎咸淡」展开。
 * 展开/收起可反复切换（横幅常驻）。
 */
function LowQualityHero({
  thumbsDown,
  open,
  onToggle,
}: {
  thumbsDown: number
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()

  // 展开态：还原为横条横幅（与 BlockedNotice 一致的紧凑条状），
  // 常驻内容上方，字体/配色与评论、回复的低质条统一。
  if (open) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-dashed border-orange-400/30 bg-orange-400/5 px-3.5 py-2.5 text-xs text-muted-foreground">
        <ThumbsDown className="size-3.5 shrink-0 text-orange-300" />
        <span className="font-medium text-orange-300/90">
          {t("community.lowQualityLabel")}
        </span>
        <span>
          {t("communityDetail.lowQualityHeroDesc", { count: thumbsDown })}
        </span>
        <span className="min-w-0 flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={onToggle}
        >
          <EyeOff className="size-3" />
          {t("settings.blockedCollapse")}
        </Button>
      </div>
    )
  }

  // 折叠态：大卡片占位横幅（居中大 👎 + 标题 + 被踩次数 + 展开按钮）
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-orange-400/30 bg-orange-400/5 px-6 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-full border border-orange-400/40 bg-orange-400/10">
        <ThumbsDown className="size-7 text-orange-300" />
      </span>
      <p className="text-lg font-semibold tracking-wide text-orange-300">
        {t("community.lowQualityLabel")}
      </p>
      <p className="text-base leading-relaxed text-foreground/75">
        {t("communityDetail.lowQualityHeroDesc", { count: thumbsDown })}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1 h-auto gap-1.5 px-3 py-1.5 text-sm font-semibold text-foreground/80 hover:bg-muted hover:text-foreground"
        onClick={onToggle}
      >
        <Eye className="size-4" />
        {t("communityDetail.lowQualityHeroExpand")}
      </Button>
    </div>
  )
}

/**
 * 单条顶层评论：评论卡片 + 卡片内「回复板块」
 * 回复板块仿 GitHub 官方样式：竖向 steps 将回复头像串联（小头像 + 贯穿竖线），
 * 回复内容无边框扁平展示，与评论卡片形成层级区分。回复他人时显示
 * 「回复 @xxx」引用；被采纳显示「已采纳答案」徽章。
 */
function CommentItem({
  node,
  discussionAuthor,
  canInteract,
  onToggleReaction,
  blocks,
}: {
  node: CommentNode
  discussionAuthor: string
  canInteract: boolean
  onToggleReaction: (subjectId: string, content: string, active: boolean) => void
  /** 社区软屏蔽偏好（用户屏蔽 / 踩贴过滤） */
  blocks: CommunityBlocks
}) {
  const { t } = useTranslation()
  const { comment, replies } = node
  // 软屏蔽判定：hide → 整条评论（含回复）不渲染；collapse → 折叠提示条
  const reason = resolveBlockReason(blocks, {
    author: comment.author,
    reactions: comment.reactions,
  })
  const [expanded, setExpanded] = useState(false)

  if (reason && blocks.mode === "hide") return null

  return (
    <div>
      {/* 低质横幅常驻：提供展开 / 再次折叠 */}
      {reason && (
        <BlockedNotice
          open={expanded}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
      {(expanded || !reason) && (
        <div className="flex gap-3">
        {/* 头像（顶层评论用大尺寸） */}
        <div className="shrink-0 pt-0.5">
          <UserAvatar
            url={comment.avatarUrl}
            name={comment.author}
            size="lg"
          />
        </div>

        {/* 内容 */}
        <div className="min-w-0 flex-1">
          {/* 头部：作者 · 徽章 · 时间 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-foreground">
              {comment.author}
            </span>
            {comment.author === discussionAuthor && (
              <Badge className="border-violet-400/40 bg-violet-400/10 font-mono text-[10px] text-violet-300">
                {t("communityDetail.authorBadge")}
              </Badge>
            )}
            {comment.isAnswer && (
              <Badge className="border-emerald-400/40 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">
                <CheckCircle2 className="mr-1 size-3" />
                {t("communityDetail.answerBadge")}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              · {formatRelativeTime(comment.createdAt)}
            </span>
            {/* 用户屏蔽快捷按钮 */}
            <BlockUserButton login={comment.author} size="icon" />
          </div>

          {/* 回复引用（回复他人时显示） */}
          {comment.replyToAuthor && (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <CornerDownRight className="size-3" />
              {t("communityDetail.reply")}
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

          {/* 回复板块：竖向 steps 串联回复头像（GitHub 官方回复样式） */}
          {replies.length > 0 && (
            <div className="mt-3 border-t border-border/60 pt-3">
              <div className="mb-2.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                <CornerDownRight className="size-3" />
                {t("communityDetail.repliesCount", { count: replies.length })}
              </div>
              {replies.map((reply, idx) => (
                <ReplyRow
                  key={reply.id}
                  reply={reply}
                  discussionAuthor={discussionAuthor}
                  canInteract={canInteract}
                  onToggleReaction={onToggleReaction}
                  isLast={idx === replies.length - 1}
                  blocks={blocks}
                />
              ))}
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  )
}

export function CommunityDetailPage() {
  const { t } = useTranslation()
  const { number } = useParams<{ number: string }>()
  // 社区来源：/community/dsh/:number（蓝鲸社区，只读）| /community/dpc/:number（浪尖酒馆）
  // 路由 source 段为静态段，需从 pathname 解析
  const { pathname } = useLocation()
  const source = pathname.split("/")[2] === "dsh" ? "dsh" : "dpc"
  const num = Number(number)
  const { user } = useAuth()
  const { loginHref } = useAuthHrefs()
  // 社区来源：/community/dsh/:number（蓝鲸社区，只读）| /community/dpc/:number（浪尖酒馆）
  // t 引用随语言变化 → 语言切换时重新解析社区文案（label/description/对侧名）
  const info = useMemo(() => resolveCommunity(source, t), [source, t])
  const [detail, setDetail] = useState<DiscussionDetail | null>(null)
  const [state, setState] = useState<"loading" | "unauthorized" | "error" | "ok">(
    "loading"
  )
  const [submitting, setSubmitting] = useState(false)
  // 评论排序方式（默认 oldest = 时间正序，符合「时间线」语义）
  const [sortMode, setSortMode] = useState<SortMode>("oldest")

  // 社区软屏蔽偏好（本地过滤，非 API 操作）
  const { blocks } = useCommunityBlocks()
  // 主贴（OP）软屏蔽：hide → 不渲染正文卡片；collapse → 折叠提示条
  const [opExpanded, setOpExpanded] = useState(false)

  // 是否可回复：由 discussion 实际状态动态判定（非硬编码社区开关）
  // 管理员锁定（locked）或关闭（closed）的讨论均不可回复
  const canReply = !!detail && !detail.locked && !detail.closed

  // 评论树（按排序方式构建；子回复恒按时间正序）
  const commentTree = useMemo(
    () => (detail ? buildCommentTree(detail.comments, sortMode) : []),
    [detail, sortMode]
  )

  // 浏览器 title：随社区名 + 帖子标题（加载后覆盖 App 层通用 title）
  usePageMeta({
    title: detail
      ? t("seo.detailPageTitle", {
          title: detail.title,
          community: info.label,
        })
      : t("seo.postTitle", { number: num }),
  })

  useEffect(() => {
    let alive = true
    // setTimeout 宏任务：避免 effect 同步路径里 setState（React Compiler
    // set-state-in-effect lint）。首次挂载 state 已是初始值，宏任务延迟一拍
    // 无感；清理时连带取消，避免已卸载后 setState。
    const id = window.setTimeout(() => {
      if (!Number.isInteger(num) || num <= 0) {
        setState("error")
        return
      }
      setState("loading")
      const loadDetail =
        source === "dsh"
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
    }, 0)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
    // user 进依赖：登录回跳后 user 就绪 → 重跑本 effect 重新拉详情
    // （官方社区匿名 401 → error；带 token 后成功）。函数体未直接读取 user
    // （token 已注入 octokit client），此为依赖触发的重拉，豁免 exhaustive-deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [num, source, user])

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
      // 递归更新评论及其嵌套回复（replies 两层结构，乐观更新需下探）
      const updateCommentReactions = (
        list: DiscussionComment[]
      ): DiscussionComment[] =>
        list.map((c) =>
          c.id === subjectId
            ? { ...c, reactions: apply(c.reactions) }
            : { ...c, replies: updateCommentReactions(c.replies) }
        )
      return { ...prev, comments: updateCommentReactions(prev.comments) }
    })
  }

  /** 写操作失败时的降级：按失败原因针对性提示 + 引导跳转 GitHub */
  const handleWriteFallback = (failure?: WriteFailure) => {
    if (failure?.kind === "forbidden") {
      toast.error(t("communityDetail.writeForbiddenTitle"), {
        description: t("communityDetail.writeForbiddenDesc"),
        action: {
          label: t("communityDetail.goGitHub"),
          onClick: () =>
            detail && window.open(detail.url, "_blank", "noopener,noreferrer"),
        },
      })
      return
    }
    if (failure?.kind === "rate_limited") {
      toast.error(t("communityDetail.rateLimitedTitle"), {
        description: t("communityDetail.rateLimitedDesc"),
      })
      return
    }
    toast.error(t("communityDetail.writeFailedTitle"), {
      description: t("communityDetail.writeFailedDesc"),
      action: {
        label: t("communityDetail.goGitHub"),
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
      toast.info(t("communityDetail.lockedToast"))
      return
    }
    if (!user) {
      toast.info(t("communityDetail.needLoginToast"))
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
        toast.success(t("communityDetail.replyPosted"))
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
              {t("plugin.breadcrumbHome")}
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
          <p className="text-lg font-medium text-foreground">{t("communityDetail.loginToChat")}</p>
          <p className="text-sm text-muted-foreground">
            {t("communityDetail.loginToReadDesc")}
          </p>
          <Button asChild size="sm" className="mt-2">
            {/* 真实导航：/auth/login 由 Worker 处理，无前端路由 */}
            <a href={loginHref}>
              <User className="size-4" />
              {t("common.login")}
            </a>
          </Button>
        </div>
      )}

      {state === "error" && !needsLogin && (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-lg font-medium text-foreground">{t("plugin.errorTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("communityDetail.discussionError")}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 border-border bg-card text-foreground hover:bg-accent"
          >
            <ArrowLeft className="size-3.5" />
            <Link to={`/community/${info.source}`}>
              {t("communityDetail.backTo", { name: info.label })}
            </Link>
          </Button>
        </div>
      )}

      {detail && state === "ok" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* ── 左栏：主贴卡片 + 评论卡片（两卡片分离） ── */}
          <main className="min-w-0 space-y-6">
            {(() => {
              const opReason = resolveBlockReason(blocks, {
                author: detail.author,
                reactions: detail.reactions,
              })
              return (
                <>
                  {/* 低质帖（OP 命中）：最高优先级——整个帖子（OP + 评论 + 回复）
                      一并折叠成大卡片横幅；hide 模式 URL 直达同样显示（可展开） */}
                  {opReason && (
                    <LowQualityHero
                      thumbsDown={thumbsDownCount(detail.reactions)}
                      open={opExpanded}
                      onToggle={() => setOpExpanded((v) => !v)}
                    />
                  )}
                  {(!opReason || opExpanded) && (
            <>
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
                        {t("communityDetail.initiator")}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("communityDetail.startedAt", {
                        time: formatRelativeTime(detail.createdAt),
                      })}
                    </p>
                  </div>
                  {/* 用户屏蔽快捷按钮（OP） */}
                  <BlockUserButton login={detail.author} size="icon" className="self-start" />
                </div>

                <a
                  href={detail.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t("common.viewOnGitHub")}
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

            {/* 评论 bar：{n} comments · {m} replies（左）+ outline 排序 tabs（右），左右分布 */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
              <span className="text-sm font-medium text-foreground">
                {t("communityDetail.commentsAndReplies", {
                  comments: detail.commentTotalCount,
                  replies: detail.replyTotalCount,
                })}
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
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* 回复内容平展（每条独立，不套大卡片） */}
            {commentTree.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                <CornerDownRight className="size-4" />
                {t("communityDetail.noComments")}
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
                    blocks={blocks}
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
                      ? t("communityDetail.lockedReply")
                      : detail.closed
                      ? t("communityDetail.closedReply")
                      : t("communityDetail.cannotReply")}
                  </span>
                  <Button asChild size="sm" variant="outline">
                    <a href={detail.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-4" />
                      {t("communityDetail.joinOnGithub")}
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
                  <span>{t("communityDetail.loginToReply")}</span>
                  <Button asChild size="sm" variant="outline">
                    <a href={loginHref}>
                      <User className="size-4" />
                      {t("common.login")}
                    </a>
                  </Button>
                </div>
              )}
            </div>
            </>
                  )}
                </>
              )
            })()}
          </main>

          {/* ── 右栏：边栏（sticky 固定，滚动不消失；与插件详情页一致） ── */}
          <aside className="space-y-4 lg:sticky lg:top-34.5 lg:self-start">
            {/* 作者卡片（3 行：头像占前两行 / 名字 / 时间 / 评论数+投票数） */}
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <UserAvatar url={detail.authorAvatarUrl} name={detail.author} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">
                    {detail.author}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("communityDetail.activity", {
                      time: formatRelativeTime(detail.createdAt),
                      time2: formatRelativeTime(detail.updatedAt),
                    })}
                  </p>
                </div>
                {/* 用户屏蔽快捷按钮（侧栏） */}
                <BlockUserButton login={detail.author} size="icon" />
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <MessagesSquare className="size-3.5 text-cyan-300/80" />
                  {t("communityDetail.commentsCount", {
                    count: detail.commentTotalCount,
                  })}
                </span>
                <span className="flex items-center gap-1.5">
                  <ArrowUp className="size-3.5 text-cyan-300/80" />
                  {t("communityDetail.votesCount", { count: detail.upvoteCount })}
                </span>
              </div>
            </div>

            {/* 分类 */}
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground">
                {t("communityDetail.category")}
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
                  {t("communityDetail.moreDiscussions")}
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
                {t("communityDetail.joinOnGithub")}
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
    /* 主题变量接管：github-markdown-css（变量驱动 base 版）的
       --fgColor-* / --bgColor-* / --borderColor-* → 站点 shadcn token，
       使 markdown 排版随站点浅色/深色主题（html.dark）自动切换 */
    --fgColor-default: var(--foreground);
    --fgColor-muted: var(--muted-foreground);
    --fgColor-accent: var(--primary);
    --fgColor-attention: var(--primary);
    --fgColor-danger: var(--foreground);
    --fgColor-success: var(--foreground);
    --fgColor-done: var(--foreground);
    --bgColor-default: transparent;
    --bgColor-muted: var(--muted);
    --bgColor-neutral-muted: var(--muted);
    --bgColor-attention-muted: var(--muted);
    --borderColor-default: var(--border);
    --borderColor-muted: var(--border);
    --borderColor-accent-emphasis: var(--primary);
    --borderColor-attention-emphasis: var(--border);
    --borderColor-danger-emphasis: var(--border);
    --borderColor-done-emphasis: var(--border);
    --borderColor-success-emphasis: var(--border);
  }
  /* 链接用站点主色（浅色深蓝 / 深色海洋青） */
  .readme-body.markdown-body a { color: var(--primary); }
  .readme-body.markdown-body a:hover { color: color-mix(in oklab, var(--primary) 72%, var(--foreground)); }
  .readme-body.markdown-body img { display: inline; vertical-align: baseline; height: auto; }
  .readme-body.markdown-body pre { background-color: var(--muted); }
`

/** 渲染 markdown → HTML（GFM + raw HTML，供 DOMPurify 消毒后注入） */
function renderMarkdown(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
      {md}
    </ReactMarkdown>
  )
}
