// ---------------------------------------------------------------------------
// GitHubStarBadge —— 自绘 GitHub stars 徽章（替代 img.shields.io 外部服务）
//   展示：星标图标 + 实时 star 数（octokit 匿名拉取，失败回退星标占位）
//   交互：点击不跳转 GitHub，而是派发 SHOW_STAR_FOLLOW_EVENT → 弹出
//   star/follow 引导卡片（已 star 且已 follow 时引导组件不响应）。
//
// 样式：无外卡片包裹（去掉白底/描边/投影），按 footer 深色背景协调——
//   ghost（默认）：透明胶囊，文字继承上下文（深色底上恒浅色，天然随 footer）
//   pill：淡色底胶囊 + 细描边（hover 提亮）
//   高度固定 h-5（20px）与 footer 行高一致；颜色走 footer 白色系而非主题变量
//   （footer 恒深色 bg-slate-950/60，浅色文字在任何主题下均可读）。
// ---------------------------------------------------------------------------

import { useEffect, useState, type MouseEvent } from "react"
import { Star } from "lucide-react"
import { useTranslation } from "react-i18next"

import { octokit } from "@/lib/github/client"
import { SHOW_STAR_FOLLOW_EVENT } from "@/components/community/star-follow-guide"
import { cn } from "@/lib/utils"

/** 标准 star 数格式（项目统一方案：123、1k、1.5k） */
function formatCount(count: number | null): string {
  if (count === null) return "··"
  if (count < 1000) return String(count)
  const k = (count / 1000).toFixed(1)
  // 去尾零：1000 → "1k"，1500 → "1.5k"
  return `${k.replace(/\.0$/, "")}k`
}

/** 点击徽章 → 主动弹出 star/follow 引导（组件内部已 star+follow 则不响应） */
function handleBadgeClick(e: MouseEvent<HTMLButtonElement>): void {
  e.preventDefault()
  window.dispatchEvent(new CustomEvent(SHOW_STAR_FOLLOW_EVENT))
}

export type GitHubStarBadgeVariant = "ghost" | "pill"

/** 各 variant 的基础类（深色 footer 场景恒浅色文字） */
const VARIANT_CLASSES: Record<GitHubStarBadgeVariant, string> = {
  // 透明胶囊：完全融入 footer，hover 淡背景提亮
  ghost:
    "text-white/70 hover:bg-white/10 hover:text-sky-200",
  // 淡底胶囊 + 细描边：轻量分组感
  pill:
    "border border-white/15 bg-white/10 text-white/80 hover:border-sky-300/40 hover:bg-white/15 hover:text-sky-200",
}

export function GitHubStarBadge({
  repo = "evil7/deepSea",
  variant = "ghost",
  className,
}: {
  /** 仓库 "owner/name" */
  repo?: string
  /** 样式变体（默认 ghost 无外框；pill 带淡底胶囊） */
  variant?: GitHubStarBadgeVariant
  className?: string
}) {
  const { t } = useTranslation()
  const [stars, setStars] = useState<number | null>(null)

  // 匿名拉取 stargazers_count（失败静默保留占位）
  useEffect(() => {
    const [owner, name] = repo.split("/")
    if (!owner || !name) return
    let alive = true
    octokit
      .request("GET /repos/{owner}/{repo}", { owner, repo: name })
      .then((r) => {
        if (alive) setStars(r.data.stargazers_count ?? null)
      })
      .catch(() => {
        /* 匿名限流/网络错误：保留占位 */
      })
    return () => {
      alive = false
    }
  }, [repo])

  const handleClick = handleBadgeClick

  return (
    <button
      type="button"
      onClick={handleClick}
      title={t("starFollow.badgeTitle")}
      aria-label={t("starFollow.badgeTitle")}
      className={cn(
        "group flex h-5 items-center gap-1 rounded-full px-1.5 text-xs font-medium transition-colors",
        VARIANT_CLASSES[variant],
        className
      )}
    >
      <Star className="size-3 fill-amber-400/90 text-amber-400/90 transition-transform group-hover:scale-110" />
      <span className="font-semibold tabular-nums leading-none">{formatCount(stars)}</span>
    </button>
  )
}
