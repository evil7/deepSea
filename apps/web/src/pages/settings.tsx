// ---------------------------------------------------------------------------
// /settings —— 用户管理页（RequireAuth 保护）
//   分区：
//   · 外观偏好：界面语言（zh-CN / en-US）+ 明暗主题（浅色 / 深色 / 跟随系统）
//   · 安全审计：互联日志展示（/auth/interconnect-log，谁、何时、以何种方式连过本机 dsh）
//   · 社区屏蔽：软屏蔽（纯前端过滤）——按用户屏蔽 + 踩贴（THUMBS_DOWN）阈值过滤
//   · 账号：重新授权（GitHub scope 更新）+ 登出
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Eye,
  Globe,
  LogOut,
  RefreshCw,
  ScrollText,
  ShieldBan,
  ShieldCheck,
  Sun,
  Trash2,
  TriangleAlert,
  Undo2,
  User,
  UserX,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useAuth } from "@/hooks/use-auth"
import { useAuthHrefs } from "@/hooks/use-auth-hrefs"
import { useTheme } from "@/components/theme-provider"
import { useCommunityBlocks } from "@/hooks/use-community-blocks"
import { useUserPreferences } from "@/hooks/use-user-preferences"
import { searchUsers, type UserSearchItem } from "@/lib/github/client"
import { PageHeader } from "@/components/layout/page-header"
import { usePageEnter } from "@/components/showcase/page-enter"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/github/discussions"

/** 审计日志行（Worker /auth/interconnect-log 返回结构） */
interface AuditLogRow {
  id: number
  github_id: number | null
  event: string
  detail: string | null
  ip: string | null
  created_at: number
  /** 事件说明（LEFT JOIN audit_event_types 填充） */
  description?: string | null
}

/** 事件 → 图标（按事件码语义映射；未知事件回退通用盾牌） */
function eventIcon(event: string) {
  switch (event) {
    case "device_grant":
      return ShieldCheck
    case "tunnel_report":
      return Globe
    case "tunnel_delete":
      return UserX
    case "tunnel_access":
      return Eye
    default:
      return ShieldCheck
  }
}

/** 分段选择器（通用小块按钮组，用于语言 / 主题 / 模式） */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-1 rounded-lg border border-border bg-muted p-1", className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === opt.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/** 分区卡片外壳：图标 + 标题（标题放大，无描述冗余）+ 内容 */
function SettingsCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {title}
        </h2>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { user, logout, destroyedAt } = useAuth()
  const { loginHref } = useAuthHrefs()
  const { theme, setTheme } = useTheme()
  const {
    blocks,
    update,
    unblockUser,
    setThumbsDownThreshold,
    setMode,
  } = useCommunityBlocks()
  // 偏好（语言/主题也随账号同步到 D1）
  const { prefs: userPrefs, save: savePrefs } = useUserPreferences()
  const pageRef = usePageEnter<HTMLDivElement>()

  // 语言偏好（"" / system = 跟随系统 → Segmented 显示跟随系统）
  const languagePref =
    userPrefs.language === "zh-CN" || userPrefs.language === "en-US"
      ? userPrefs.language
      : "system"

  /** 应用语言（支持跟随系统：先切到浏览器语言，再清 detector 缓存 → 刷新回退系统） */
  const applyLanguage = async (lang: "zh-CN" | "en-US" | "system") => {
    savePrefs({ language: lang })
    if (lang === "system") {
      const sys = navigator.language.startsWith("zh") ? "zh-CN" : "en-US"
      await i18n.changeLanguage(sys)
      // changeLanguage 会把 detector 缓存写回 deepsea.lang → 再清掉，
      // 刷新后 i18next 回退 navigator 系统语言（而非固定缓存值）
      try {
        localStorage.removeItem("deepsea.lang")
      } catch {
        /* ignore */
      }
    } else {
      await i18n.changeLanguage(lang)
    }
  }

  // ── 审计日志 ──
  const [logs, setLogs] = useState<AuditLogRow[] | null>(null)
  const [logsError, setLogsError] = useState(false)
  const loadLogs = useCallback(() => {
    fetch("/auth/interconnect-log?limit=50", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { authed?: boolean; logs?: AuditLogRow[] }) => {
        setLogs(data.logs ?? [])
        setLogsError(false)
      })
      .catch(() => {
        setLogs([])
        setLogsError(true)
      })
  }, [])

  // 挂载 + 刷新按钮复用同一 loader（setTimeout 宏任务规避 set-state-in-effect lint）
  useEffect(() => {
    const id = window.setTimeout(loadLogs, 0)
    return () => window.clearTimeout(id)
  }, [loadLogs])

  // ── 屏蔽用户输入 ──
  const [blockInput, setBlockInput] = useState("")
  // 搜索建议（防抖 1s 后请求 GitHub 用户搜索，至多 50 条）
  const [suggestions, setSuggestions] = useState<UserSearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  // 建议面板开关（Popover 受控；自动向上/向下弹出，无需手动判断方向）
  const [popoverOpen, setPopoverOpen] = useState(false)
  const searchTimerRef = useRef<number | null>(null)

  // 防抖搜索：停止输入 1s 后请求；清空输入即重置
  // 全部状态更新放宏任务（避免 React Compiler set-state-in-effect lint）
  useEffect(() => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current)
    }
    const clean = blockInput.trim().replace(/^@/, "")
    const id = window.setTimeout(() => {
      if (!clean) {
        setSuggestions([])
        setSearching(false)
        setSearched(false)
        return
      }
      setSearching(true)
      searchTimerRef.current = window.setTimeout(() => {
        void searchUsers(clean, 50).then((items) => {
          setSuggestions(items)
          setSearching(false)
          setSearched(true)
        })
      }, 1000)
    }, 0)
    return () => {
      window.clearTimeout(id)
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current)
      }
    }
  }, [blockInput])

  const addBlocked = (login: string) => {
    if (!login) return
    update({
      ...blocks,
      blockedUsers: unique([...blocks.blockedUsers, login]),
    })
    setBlockInput("")
    setSuggestions([])
    setSearched(false)
    setPopoverOpen(false)
  }

  const handleAddBlocked = () => {
    addBlocked(blockInput.trim().replace(/^@/, ""))
  }

  // ── 销毁账号（危险区；软删除，24h 内可撤回） ──
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [destroyConfirm, setDestroyConfirm] = useState("")
  const [destroying, setDestroying] = useState(false)
  const confirmOk =
    !!user && destroyConfirm.trim() === user.login
  const handleDestroy = async () => {
    if (!user || destroying) return
    setDestroying(true)
    try {
      const res = await fetch("/auth/account/destroy", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
      if (!res.ok) throw new Error(String(res.status))
      setDestroyOpen(false)
      await logout()
      toast.success(t("settings.destroySuccess"))
    } catch {
      toast.error(t("settings.destroyError"))
    } finally {
      setDestroying(false)
    }
  }

  return (
    <>
      <div
        ref={pageRef}
        className="relative z-10 mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-4xl px-4 py-10 sm:px-6"
      >
        <PageHeader
          title={t("settings.title")}
          description={t("settings.description")}
        />

        {/* 账号概览（当前登录用户） */}
        {user && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-card p-4">
            <Avatar className="size-10 border border-border/60">
              <AvatarImage src={user.avatar_url} alt={user.login} referrerPolicy="no-referrer" />
              <AvatarFallback className="text-sm">
                {user.login.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">
                {user.name?.trim() || user.login}
              </p>
              <p className="text-xs text-muted-foreground">@{user.login}</p>
            </div>
            {/* 退出登录：普通弱化样式（ghost），不强调 */}
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              <LogOut className="size-3.5" />
              {t("settings.logout")}
            </Button>
          </div>
        )}

        <div className="space-y-6">
          {/* ── 外观偏好 ── */}
          <SettingsCard icon={Sun} title={t("settings.appearance")}>
            <div className="space-y-5">
              {/* 语言（含跟随系统） */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">
                  {t("settings.language")}
                </p>
                <Segmented
                  value={languagePref}
                  options={[
                    { value: "zh-CN", label: "简体中文" },
                    { value: "en-US", label: "English" },
                    { value: "system", label: t("settings.languageSystem") },
                  ]}
                  onChange={(lang) => applyLanguage(lang)}
                />
              </div>

              {/* 主题 */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">
                  {t("settings.theme")}
                </p>
                <Segmented
                  value={theme}
                  options={[
                    { value: "light", label: t("settings.themeLight") },
                    { value: "dark", label: t("settings.themeDark") },
                    { value: "system", label: t("settings.themeSystem") },
                  ]}
                  onChange={(v) => {
                    setTheme(v)
                    // 随账号同步（D1）
                    savePrefs({ theme: v })
                  }}
                />
              </div>
            </div>
          </SettingsCard>

          {/* ── 安全审计 ── */}
          <SettingsCard icon={ScrollText} title={t("settings.audit")}>
            <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
              <p className="text-xs text-muted-foreground">
                {t("settings.auditHint")}
              </p>
              <Button variant="outline" size="sm" onClick={loadLogs}>
                <RefreshCw className="size-3.5" />
                {t("settings.refresh")}
              </Button>
            </div>

            <div className="mt-2 max-h-80 space-y-1 overflow-y-auto">
              {logs === null ? (
                Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={`log-skeleton-${i}`} className="h-12 w-full bg-muted" />
                ))
              ) : logs.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  <ShieldCheck className="size-4" />
                  {logsError
                    ? t("settings.auditLoadError")
                    : t("settings.auditEmpty")}
                </div>
              ) : (
                logs.map((log) => {
                  const Icon = eventIcon(log.event)
                  return (
                    <div
                      key={log.id}
                      className="flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/50"
                    >
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                        <Icon className="size-3.5 text-muted-foreground" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground">
                          {log.description ?? log.event}
                        </p>
                        {log.detail && (
                          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                            {log.detail}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[10px] text-muted-foreground">
                          {formatRelativeTime(new Date(log.created_at).toISOString())}
                        </p>
                        {log.ip && (
                          <p className="font-mono text-[10px] text-muted-foreground/60">
                            {log.ip}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </SettingsCard>

          {/* ── 社区屏蔽（软屏蔽，非 API 操作） ── */}
          <SettingsCard icon={ShieldBan} title={t("settings.blocks")}>
            {/* 踩贴过滤（上） */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("settings.thumbsDown")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.thumbsDownDesc")}
                </p>
              </div>
              <Segmented
                value={String(blocks.thumbsDownThreshold)}
                options={[
                  { value: "0", label: t("settings.thumbsDownOff") },
                  { value: "3", label: "≥ 3" },
                  { value: "5", label: "≥ 5" },
                  { value: "10", label: "≥ 10" },
                ]}
                onChange={(v) => setThumbsDownThreshold(Number(v))}
              />
            </div>

            {/* 处理模式（下；踩贴关闭时不可改动） */}
            <div
              className={cn(
                "mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5",
                blocks.thumbsDownThreshold <= 0 &&
                  "pointer-events-none opacity-50"
              )}
            >
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("settings.blockMode")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.blockModeDesc")}
                </p>
              </div>
              <Segmented
                value={blocks.mode}
                options={[
                  { value: "collapse", label: t("settings.blockModeCollapse") },
                  { value: "hide", label: t("settings.blockModeHide") },
                ]}
                onChange={setMode}
              />
            </div>

            {/* 屏蔽用户 */}
            <div className="mt-5 border-t border-border pt-5">
              <p className="text-sm font-medium text-foreground">
                {t("settings.blockedUsers")}
              </p>
              {/* 输入 + 搜索建议（Popover 自适应方向弹出；按钮高度与输入框一致） */}
              <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                <PopoverAnchor asChild>
                  <div className="mt-2 flex gap-2">
                    <Input
                      value={blockInput}
                      onChange={(e) => {
                        const v = e.target.value
                        setBlockInput(v)
                        // 有输入时自动打开建议面板
                        if (v.trim()) setPopoverOpen(true)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const first = suggestions[0]
                          if (first) addBlocked(first.login)
                          else handleAddBlocked()
                        }
                      }}
                      onFocus={() => {
                        if (blockInput.trim()) setPopoverOpen(true)
                      }}
                      placeholder={t("settings.blockedUsersPlaceholder")}
                      className="h-10 border-border bg-background text-foreground placeholder:text-muted-foreground"
                    />
                    <Button onClick={handleAddBlocked} className="h-10 shrink-0">
                      <UserX className="size-4" />
                      {t("settings.blockAdd")}
                    </Button>
                  </div>
                </PopoverAnchor>

                {/* 建议面板（至多 50 条；自动向上/向下避开视口边缘） */}
                <PopoverContent
                  align="start"
                  sideOffset={8}
                  className="w-[min(26rem,calc(100vw-2rem))] p-1.5"
                >
                  {searching ? (
                    <div className="space-y-1.5 p-2.5">
                      {Array.from({ length: 4 }, (_, i) => (
                        <Skeleton key={`sug-skeleton-${i}`} className="h-9 w-full bg-muted" />
                      ))}
                    </div>
                  ) : suggestions.length === 0 && searched ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      {t("settings.blockedUsersNotFound", { name: blockInput.trim() })}
                    </div>
                  ) : (
                    <ul className="max-h-72 overflow-y-auto">
                      {suggestions.map((u) => {
                        const already = blocks.blockedUsers.some(
                          (b) => b.toLowerCase() === u.login.toLowerCase()
                        )
                        return (
                          <li key={u.login}>
                            <button
                              type="button"
                              disabled={already}
                              onClick={() => addBlocked(u.login)}
                              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Avatar className="size-6 border border-border/60 bg-muted">
                                {u.avatarUrl ? (
                                  <AvatarImage src={u.avatarUrl} alt={u.login} />
                                ) : null}
                                <AvatarFallback className="text-[10px]">
                                  {u.login.slice(0, 2).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                {u.name?.trim() || u.login}
                              </span>
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                @{u.login}
                              </span>
                              {already && (
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {t("settings.blockedAlready")}
                                </span>
                              )}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </PopoverContent>
              </Popover>

              {blocks.blockedUsers.length === 0 ? (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <User className="size-3.5" />
                  {t("settings.blockedUsersEmpty")}
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {blocks.blockedUsers.map((login) => (
                    <span
                      key={login}
                      className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground"
                    >
                      <UserX className="size-3 text-muted-foreground" />
                      {login}
                      <button
                        type="button"
                        onClick={() => unblockUser(login)}
                        aria-label={t("settings.blockRemove", { name: login })}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </SettingsCard>

          {/* ── 危险区：销毁 deepSea 账号（软删除，24h 内可撤回） ── */}
          <section className="rounded-xl border border-destructive/30 bg-card p-5 sm:p-6">
            {/* 标题行：图标 + 标题 + 右侧操作（与其他板块一致） */}
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10">
                <TriangleAlert className="size-4 text-destructive" />
              </span>
              <h2 className="min-w-0 flex-1 text-base font-semibold tracking-tight text-foreground">
                {t("settings.destroyAccount")}
              </h2>
              {destroyedAt ? (
                /* 待销毁状态：撤回 = 重新 OAuth 登录（callback 清 destroyed_at） */
                <Button asChild variant="outline" size="sm" className="shrink-0">
                  <a href={loginHref}>
                    <Undo2 className="size-3.5" />
                    {t("settings.destroyRevoke")}
                  </a>
                </Button>
              ) : (
                <AlertDialog open={destroyOpen} onOpenChange={setDestroyOpen}>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" className="shrink-0">
                      <Trash2 className="size-3.5" />
                      {t("settings.destroyAction")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("settings.destroyConfirmTitle")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("settings.destroyConfirmDesc")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <Input
                      value={destroyConfirm}
                      onChange={(e) => setDestroyConfirm(e.target.value)}
                      placeholder={t("settings.destroyInputPlaceholder", {
                        name: user?.login ?? "",
                      })}
                      className="h-10 border-destructive/40 focus-visible:border-destructive"
                    />
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={destroying}>
                        {t("settings.destroyCancel")}
                      </AlertDialogCancel>
                      <Button
                        variant="destructive"
                        disabled={!confirmOk || destroying}
                        onClick={() => void handleDestroy()}
                      >
                        {destroying
                          ? t("settings.destroying")
                          : t("settings.destroyConfirmAction")}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>

            {/* 描述行：正常状态 vs 待销毁状态（倒计时）；满行展示不因宽度换行 */}
            <p className="mt-2 w-full text-xs leading-normal text-muted-foreground">
              {destroyedAt
                ? t("settings.destroyPendingDesc", {
                    time: destroyCountdown(destroyedAt, t),
                  })
                : t("settings.dangerZoneDesc")}
            </p>
          </section>
        </div>
      </div>
    </>
  )
}

/** 销毁倒计时（24h 撤回窗口剩余）：如「23 小时 59 分」。 */
function destroyCountdown(
  destroyedAt: number,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const remain = destroyedAt + 24 * 60 * 60 * 1000 - Date.now()
  if (remain <= 0) return t("time.justNow")
  const totalMin = Math.max(1, Math.ceil(remain / 60000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0
    ? t("settings.destroyCountdownHm", { h, m })
    : t("settings.destroyCountdownM", { m })
}

/** 数组去重（大小写不敏感） */
function unique(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const key = item.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  return out
}
