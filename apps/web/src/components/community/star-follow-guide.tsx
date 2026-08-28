// ---------------------------------------------------------------------------
// StarFollowGuide —— star/follow 引导（sonner 交互 toast，左下角，10s 自动关闭）
//
// 展示前提（全部满足才触发）：
//   ① 已登录（有 token）
//   ② 用户使用过 /links 且存在纳管节点（localStorage HAS_NODES_KEY）
//   ③ 已探测 star/follow 状态（octokit REST 204/404）
//   ④ 当天首次（localStorage 按日期去重）
//
// Props（参数化，默认 deepSea 本体）：
//   star="evil7/deepSea"      —— 需要 star 的仓库
//   follow=["evil7","deepwn"] —— 需要 follow 的开发者列表
//
// 交互内容：sonner 标准 toast（toast.custom，position=bottom-left，duration=10s），
//   按钮始终渲染——已 star/follow 仅 disabled；点击直接 octokit API 触发
//   （PUT /user/starred、PUT /user/following），无需跳转 GitHub。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Star, UserPlus, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { toast, type ToastT } from "sonner"

import { useAuth } from "@/hooks/use-auth"
import { octokit, getToken } from "@/lib/github/client"
import { HAS_NODES_KEY } from "@/lib/deepc-link/tunnels"
import { Button } from "@/components/ui/button"

/** localStorage 键：引导卡片每日展示去重（存日期字符串） */
const DISMISS_KEY = "deepsea:star-follow-guide"
/** 自动关闭时长（10 秒） */
const AUTO_HIDE_MS = 10_000
/** 默认仓库 / 关注列表（稳定引用，避免默认 props 每次重建） */
const DEFAULT_STAR = "evil7/deepSea"
const DEFAULT_FOLLOW: string[] = ["evil7", "deepwn"]

/**
 * 全局事件：外部（如 footer 星标徽章）点击主动弹出引导 toast。
 * 组件收到后强制重新探测 star/follow 状态——按钮始终渲染，已达成仅 disabled。
 */
export const SHOW_STAR_FOLLOW_EVENT = "deepsea:show-star-follow"

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

/** OAuth API 直接 star 仓库（PUT /user/starred；204=成功） */
async function starRepo(repo: string): Promise<boolean> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) return false
  try {
    await octokit.request("PUT /user/starred/{owner}/{repo}", { owner, repo: name })
    return true
  } catch {
    return false
  }
}

/** OAuth API 直接 follow 用户（PUT /user/following；204=成功） */
async function followUser(login: string): Promise<boolean> {
  try {
    await octokit.request("PUT /user/following/{username}", { username: login })
    return true
  } catch {
    return false
  }
}

/**
 * toast 内容：标题 + Star/Follow 交互按钮（标准 sonner toast 内容）。
 * 按钮始终渲染，已 star/follow 仅 disabled；点击 OAuth API 直调。
 */
function StarFollowToast({
  toastId,
  star,
  follow,
  initialStarred,
  initialFollowing,
}: {
  toastId: string | number
  star: string
  follow: string[]
  initialStarred: boolean
  initialFollowing: Record<string, boolean>
}) {
  const { t } = useTranslation()
  // 交互后的状态（初始为探测结果，成功后置 true → 按钮 disabled）
  const [starred, setStarred] = useState(initialStarred)
  const [following, setFollowing] = useState(initialFollowing)
  // 进行中的操作（防重复点击）
  const [busy, setBusy] = useState<Set<string>>(() => new Set())

  /** 点击 Star → OAuth API 直接触发（成功后置为已 star） */
  const handleStar = async () => {
    if (busy.has("star")) return
    setBusy((prev) => new Set(prev).add("star"))
    const ok = await starRepo(star)
    setBusy((prev) => {
      const next = new Set(prev)
      next.delete("star")
      return next
    })
    if (ok) {
      toast.success(t("starFollow.starredToast", { repo: star }))
      setStarred(true)
    } else {
      toast.error(t("starFollow.operateFailed"))
    }
  }

  /** 点击 Follow → OAuth API 直接触发（成功后置为已 follow） */
  const handleFollow = async (login: string) => {
    if (busy.has(login)) return
    setBusy((prev) => new Set(prev).add(login))
    const ok = await followUser(login)
    setBusy((prev) => {
      const next = new Set(prev)
      next.delete(login)
      return next
    })
    if (ok) {
      toast.success(t("starFollow.followedToast", { name: login }))
      setFollowing((prev) => ({ ...prev, [login]: true }))
    } else {
      toast.error(t("starFollow.operateFailed"))
    }
  }

  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card/95 p-4 shadow-lg backdrop-blur">
      {/* 头部：标题 + 关闭 */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs leading-relaxed text-foreground">
          {t("starFollow.starLine")}
        </p>
        <button
          type="button"
          onClick={() => toast.dismiss(toastId)}
          aria-label={t("common.close")}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="mt-2.5 w-full gap-1.5"
        onClick={() => void handleStar()}
        disabled={starred || busy.has("star")}
      >
        {busy.has("star") ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Star className="size-3.5" />
        )}
        {t("starFollow.starBtn")}
      </Button>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {t("starFollow.followLine")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {follow.map((login) => (
          <Button
            key={login}
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => void handleFollow(login)}
            disabled={following[login] || busy.has(login)}
          >
            {busy.has(login) ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <UserPlus className="size-3.5" />
            )}
            {login}
          </Button>
        ))}
      </div>
    </div>
  )
}

export function StarFollowGuide({
  star = DEFAULT_STAR,
  follow = DEFAULT_FOLLOW,
}: StarFollowGuideProps) {
  const { user } = useAuth()
  // 已检查标志：自动模式仅评估一次（避免重复探测 GitHub API）
  const evaluatedRef = useRef(false)
  // 当前展示的 toast id（重新弹出前先关闭旧的）
  const toastIdRef = useRef<string | number | null>(null)

  /**
   * 探测并弹出引导 toast。
   * force=true（外部点击）：跳过 has-nodes / 每日去重，强制重新探测真实状态并弹出。
   * force=false（自动）：尊重 has-nodes 条件 + 每日一次。
   */
  const evaluate = useCallback(
    async (force: boolean) => {
      if (!user) return
      if (!force) {
        // 条件②：使用过 links 且存在纳管节点
        let hasNodes = false
        try {
          hasNodes = localStorage.getItem(HAS_NODES_KEY) === "1"
        } catch {
          /* ignore */
        }
        if (!hasNodes) return
        // 条件④：当天已展示则跳过
        const today = new Date().toISOString().slice(0, 10)
        try {
          if (localStorage.getItem(DISMISS_KEY) === today) return
        } catch {
          /* ignore */
        }
      }
      // 条件③：探测 star/follow 状态（需登录 token）
      if (!getToken()) return
      const results = await Promise.all([
        hasStarred(star),
        ...follow.map((login) => isFollowing(login)),
      ])
      const [starredNow, ...followingNow] = results
      const followingMap = Object.fromEntries(
        follow.map((login, i) => [login, followingNow[i] ?? false])
      )
      // 重新弹出前关闭旧 toast
      if (toastIdRef.current !== null) {
        toast.dismiss(toastIdRef.current)
      }
      // sonner 标准交互 toast：左下角 + 10s 自动关闭
      toastIdRef.current = toast.custom(
        (t: ToastT) => (
          <StarFollowToast
            toastId={t.id}
            star={star}
            follow={follow}
            initialStarred={starredNow}
            initialFollowing={followingMap}
          />
        ),
        {
          position: "bottom-left",
          duration: AUTO_HIDE_MS,
        }
      )
      // 每日去重：展示后标记当天
      try {
        localStorage.setItem(DISMISS_KEY, new Date().toISOString().slice(0, 10))
      } catch {
        /* ignore */
      }
    },
    [user, star, follow]
  )

  // 自动模式：挂载后评估一次（宏任务规避 set-state-in-effect lint）
  useEffect(() => {
    if (!user || evaluatedRef.current) return
    evaluatedRef.current = true
    const id = window.setTimeout(() => void evaluate(false), 0)
    return () => window.clearTimeout(id)
  }, [user, evaluate])

  // 外部事件：footer 星标徽章点击 → 强制重新探测并弹出
  useEffect(() => {
    const onShow = () => void evaluate(true)
    window.addEventListener(SHOW_STAR_FOLLOW_EVENT, onShow)
    return () => window.removeEventListener(SHOW_STAR_FOLLOW_EVENT, onShow)
  }, [evaluate])

  // 卸载时关闭残留 toast
  useEffect(() => {
    return () => {
      if (toastIdRef.current !== null) {
        toast.dismiss(toastIdRef.current)
      }
    }
  }, [])

  // 展示由 sonner toast 承载，本组件不渲染 DOM
  return null
}
