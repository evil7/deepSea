// ---------------------------------------------------------------------------
// StarFollowGuide —— 左下角 star/follow 引导卡片（独立组件）
//
// 展示前提（全部满足才显示）：
//   ① 已登录（有 token）
//   ② 用户使用过 /links 且存在纳管节点（localStorage HAS_NODES_KEY）
//   ③ 尚未 star 仓库 / 尚未 follow 开发者（octokit REST 探测 204/404）
//   ④ 当天首次（localStorage 按日期去重）+ 仅显示 30 秒自动收起
//
// Props（参数化，默认 deepSea 本体）：
//   star="evil7/deepSea"      —— 需要 star 的仓库
//   follow=["evil7","deepwn"] —— 需要 follow 的开发者列表
//
// 按钮行为：新窗口打开 GitHub 对应页面（star/follow 需用户在 GitHub 完成）。
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react"
import { ExternalLink, Star, UserPlus, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useAuth } from "@/hooks/use-auth"
import { octokit, getToken } from "@/lib/github/client"
import { HAS_NODES_KEY } from "@/lib/deepc-link/tunnels"
import { Button } from "@/components/ui/button"

/** localStorage 键：引导卡片每日展示去重（存日期字符串） */
const DISMISS_KEY = "deepsea:star-follow-guide"
/** 自动收起时长（30 秒） */
const AUTO_HIDE_MS = 30_000
/** 默认仓库 / 关注列表（稳定引用，避免默认 props 每次重建） */
const DEFAULT_STAR = "evil7/deepSea"
const DEFAULT_FOLLOW: string[] = ["evil7", "deepwn"]

export interface StarFollowGuideProps {
  /** 需 star 的仓库，如 "evil7/deepSea" */
  star?: string
  /** 需 follow 的开发者列表，如 ["evil7", "deepwn"] */
  follow?: string[]
}

/** REST 探测是否已 star 仓库（204=已 / 404=未；网络错误保守视为已避免打扰） */
async function hasStarred(repo: string): Promise<boolean> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) return true
  try {
    await octokit.request("GET /user/starred/{owner}/{repo}", { owner, repo: name })
    return true
  } catch (error) {
    return (error as { status?: number }).status !== 404
  }
}

/** REST 探测是否已 follow 用户（204=已 / 404=未；网络错误保守视为已） */
async function isFollowing(login: string): Promise<boolean> {
  try {
    await octokit.request("GET /user/following/{username}", { username: login })
    return true
  } catch (error) {
    return (error as { status?: number }).status !== 404
  }
}

export function StarFollowGuide({
  star = DEFAULT_STAR,
  follow = DEFAULT_FOLLOW,
}: StarFollowGuideProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [visible, setVisible] = useState(false)
  const [needs, setNeeds] = useState<{ star: boolean; follow: string[] }>({
    star: false,
    follow: [],
  })
  // 已检查标志：仅评估一次（避免重复探测 GitHub API）
  const evaluatedRef = useRef(false)

  useEffect(() => {
    if (!user || evaluatedRef.current) return
    // 条件②：使用过 links 且存在纳管节点
    let hasNodes = false
    try {
      hasNodes = localStorage.getItem(HAS_NODES_KEY) === "1"
    } catch {
      /* ignore */
    }
    if (!hasNodes) {
      evaluatedRef.current = true
      return
    }
    // 条件④：当天已展示则跳过
    const today = new Date().toISOString().slice(0, 10)
    try {
      if (localStorage.getItem(DISMISS_KEY) === today) {
        evaluatedRef.current = true
        return
      }
    } catch {
      /* ignore */
    }
    // 条件③：探测 star/follow 状态（需登录 token）
    if (!getToken()) {
      evaluatedRef.current = true
      return
    }
    evaluatedRef.current = true
    void Promise.all([
      hasStarred(star),
      ...follow.map((login) => isFollowing(login)),
    ]).then((results) => {
      const [starred, ...following] = results
      const missingFollow = follow.filter((_, i) => !following[i])
      if (!starred || missingFollow.length > 0) {
        setNeeds({ star: !starred, follow: missingFollow })
        setVisible(true)
        // 每日去重：展示后标记当天（仅当天首次）
        try {
          localStorage.setItem(DISMISS_KEY, today)
        } catch {
          /* ignore */
        }
        // 30 秒自动收起
        const timer = window.setTimeout(() => setVisible(false), AUTO_HIDE_MS)
        return () => window.clearTimeout(timer)
      }
    })
    // 依赖：star/follow 配置变更时重新评估；user 就绪后执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, star, follow])

  if (!visible) return null

  const followNames = needs.follow.join("、")

  return (
    <div className="fixed bottom-4 left-4 z-50 w-72 max-w-[calc(100vw-2rem)] animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="rounded-xl border border-border bg-card/95 p-4 shadow-lg backdrop-blur">
        {/* 头部：关闭按钮 */}
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs leading-relaxed text-foreground">
            {t("starFollow.starLine", { repo: star })}
          </p>
          <button
            type="button"
            onClick={() => setVisible(false)}
            aria-label={t("common.close")}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {needs.star && (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="mt-2.5 w-full gap-1.5"
          >
            <a
              href={`https://github.com/${star}`}
              target="_blank"
              rel="noreferrer"
            >
              <Star className="size-3.5" />
              {t("starFollow.starBtn")}
              <ExternalLink className="size-3" />
            </a>
          </Button>
        )}

        {needs.follow.length > 0 && (
          <>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {t("starFollow.followLine", { names: followNames })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {needs.follow.map((login) => (
                <Button
                  key={login}
                  asChild
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                >
                  <a
                    href={`https://github.com/${login}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <UserPlus className="size-3.5" />
                    {login}
                    <ExternalLink className="size-3" />
                  </a>
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
