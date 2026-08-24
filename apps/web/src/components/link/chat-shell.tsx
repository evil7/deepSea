// ---------------------------------------------------------------------------
// ChatShell —— 已连接态的 chatUI 外壳（复刻官方 三栏布局）。
//
// 左 sidebar：品牌 + 新建会话 + 工作区搜索 + 会话树 + 底部【设置 + 连接状态】
// 中聊天区：header（会话标题 + 模型 + 状态徽标）+ 消息流 + 输入框（composer）
//
// 由 /link/:nodeId 路由渲染；数据来自 useDeepcLink（RTC DataChannel）。
// 底部将原「设置」按钮与右上角「连接状态」合并为并排两块：
//   左 = 设置按钮；右 = ConnectStatus（时长+状态 → hover 断开 → 确认断开）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  FileText,
  Folder,
  GitBranch,
  ListOrdered,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizonal,
  Settings,
  Trash2,
  Waves,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChatMessageList } from "@/components/link/chat-message"
import { FolderPicker } from "@/components/link/folder-picker"
import { ConnectStatus } from "@/components/link/connect-status"
import { useDeepcLink } from "@/hooks/use-deepc-link"
import { deepcClient } from "@/lib/deepc-link/client"
import { cn } from "@/lib/utils"
import type {
  AgentPresetEntry,
  AgentPresetReadResult,
  CommandItem,
  SessionSummary,
  SettingsDocumentView,
} from "@/lib/deepc-link/protocol"

const TOPBAR_H = 64

// ── 设置项：真实值 ↔ 显示标签映射（对齐官方 schema 枚举值）──────────────

/** 权限 preset：permission.defaultPreset。 */
const PERMISSION_OPTIONS = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "危险完全访问" },
]

/** 访问模式（composer 工具栏，对齐官方英文 label）。 */
const ACCESS_MODES = [
  { value: "read-only", label: "Read Only" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "Full access" },
]

/** 外观：ui-theme.preference。 */
const THEME_OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
]

/** 语言：locale.preference。 */
const LOCALE_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
]

/** 繁忙时 Enter 键行为：ui-conversation.busyEnter。 */
const ENTER_OPTIONS = [
  { value: "queue", label: "排队发送" },
  { value: "steer", label: "直接发送" },
]

/** 设置面板导航项（对齐官方 section id）。 */
type SettingsTabId = "general" | "models" | "plugins" | "presets"

const SETTINGS_NAV: { id: SettingsTabId; label: string }[] = [
  { id: "general", label: "通用设置" },
  { id: "models", label: "模型" },
  { id: "plugins", label: "插件" },
  { id: "presets", label: "Agent 预设" },
]

/** 插件 fiberPhase → 状态标签。 */
const PLUGIN_PHASE_LABEL: Record<string, string> = {
  active: "已挂载",
  loading: "加载中",
  pending: "等待依赖",
  failed: "挂载失败",
  unloading: "卸载中",
}

/** 内置 slash 命令（对齐官方命令面板）。 */
const SLASH_COMMANDS: { id: string; name: string; desc: string }[] = [
  { id: "compact", name: "compact", desc: "Compact older conversation history" },
  { id: "export", name: "export", desc: "Download this Session log as a ZIP archive" },
  { id: "feedback", name: "feedback", desc: "record feedback about this session" },
  { id: "goal", name: "goal", desc: "set or view the goal for a long-running task" },
  { id: "permission", name: "permission", desc: "Switch the permission preset (sandbox mode + approval policy)" },
  { id: "plan", name: "plan", desc: "Enter or leave plan mode" },
  { id: "model", name: "model", desc: "选择本会话使用的模型" },
]

/** 会话视图排列偏好（对齐官方 EngineStore 的 groupBy/orderBy，本地持久化）。 */
interface ViewSort {
  /** 按工作区分组 or 扁平。 */
  groupBy: "workspace" | "flat"
  /** 排序：手动 or 更新时间。 */
  orderBy: "manual" | "updated"
}
const VIEW_SORT_KEY = "deepsea:sidebar:viewSort"
const DEFAULT_VIEW_SORT: ViewSort = { groupBy: "workspace", orderBy: "manual" }
function readViewSort(): ViewSort {
  try {
    const raw = localStorage.getItem(VIEW_SORT_KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<ViewSort>
      return { groupBy: v.groupBy ?? "workspace", orderBy: v.orderBy ?? "manual" }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_VIEW_SORT
}
function writeViewSort(v: ViewSort): void {
  try {
    localStorage.setItem(VIEW_SORT_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

export function ChatShell({ onDisconnect }: { onDisconnect: () => void }) {
  const {
    state,
    hostInfo,
    model,
    workspaces,
    sessions,
    archivedSessionIds,
    activeSessionId,
    messages,
    isStreaming,
    loading,
    settings,
    plugins,
    pluginsLoaded,
    agentPresets,
    modelCatalog,
    sessionModels,
    elapsed,
    selectSession,
    sendPrompt,
    createSession,
    forkSession,
    renameWorkspace,
    deleteWorkspace,
    renameSession,
    archiveSession,
    loadWorkspace,
    refreshAll,
    updateSetting,
    readSettingsDocument,
    loadAgentPresets,
    readAgentPreset,
    copyAgentPreset,
    removeAgentPreset,
    setDefaultAgentPreset,
    selectSessionModel,
    loadCommands,
    pendingInteractions,
  } = useDeepcLink()

  const [draft, setDraft] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchActive, setSearchActive] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("general")
  const [settingsDoc, setSettingsDoc] = useState<SettingsDocumentView | null>(null)
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // 输入框 `/` 命令联想（对齐官方：输入 / 动态查 dsh 注册命令）。
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState("")
  const [slashItems, setSlashItems] = useState<CommandItem[]>([])
  const [slashLoading, setSlashLoading] = useState(false)
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set())
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [viewSortOpen, setViewSortOpen] = useState(false)
  const [viewSort, setViewSort] = useState<ViewSort>(() => readViewSort())
  const [atBottom, setAtBottom] = useState(true)
  const [wsMenuId, setWsMenuId] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const viewSortRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)

  /**
   * 把命令插入 composer（复刻官方：不自动发送，命令词用 <mark> 高亮）。
   * 追加 `/command `；若末尾已有内容，前面补一个空格。
   */
  const insertCommand = useCallback((commandId: string) => {
    const editor = editorRef.current
    if (!editor) return
    setCommandMenuOpen(false)
    setPermissionMenuOpen(false)
    setModelMenuOpen(false)
    const text = editor.textContent ?? ""
    // 追加命令词，前后确保有空格边界。
    const prevGap = text.length > 0 && !text.endsWith(" ") ? " " : ""
    const mark = document.createElement("mark")
    mark.textContent = `/${commandId}`
    const space = document.createElement("span")
    space.textContent = " "
    // 若编辑器为空或纯空白，直接插入 mark；否则追加间隙文本。
    editor.appendChild(document.createTextNode(prevGap))
    editor.appendChild(mark)
    editor.appendChild(space)
    // 同步纯文本到 draft（供 handleSend / 发送按钮启用判定）。
    setDraft(editor.textContent ?? "")
    // 光标移到末尾并聚焦。
    const sel = window.getSelection()
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    editor.focus()
  }, [])

  const closeToolbarMenus = useCallback(() => {
    setCommandMenuOpen(false)
    setPermissionMenuOpen(false)
    setModelMenuOpen(false)
  }, [])

  /**
   * 输入框 `/` 命令联想（对齐官方 composer：末尾输入 `/` 或 `/xxx` 时，
   * 动态查询 dsh 已注册命令并弹出联想下拉）。
   */
  const handleSlashEdit = useCallback(
    async (text: string) => {
      // 解析末尾是否有 `/` 命令前缀（取最后一个 token，且该 token 以 / 开头）。
      const trimmed = text.trimEnd()
      const lastToken = trimmed.split(/\s+/).pop() ?? ""
      if (lastToken.startsWith("/") && lastToken.length > 1 && activeSessionId) {
        const q = lastToken.slice(1).toLowerCase()
        setSlashOpen(true)
        setSlashQuery(q)
        setSlashLoading(true)
        try {
          const all = await loadCommands(activeSessionId)
          const filtered = q ? all.filter((c) => c.name.includes(q)) : all
          setSlashItems(filtered)
        } catch {
          setSlashItems([])
        } finally {
          setSlashLoading(false)
        }
      } else {
        // 非命令上下文 / 无 active 会话 → 收起联想。
        setSlashOpen(false)
        setSlashItems([])
      }
    },
    [activeSessionId, loadCommands]
  )

  // 点击联选项外收起 `/` 联想。
  const slashRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!slashOpen) return
    const onDown = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) {
        setSlashOpen(false)
        setSlashItems([])
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [slashOpen])

  // 点击工具栏外部时收起下拉。
  useEffect(() => {
    if (!commandMenuOpen && !permissionMenuOpen && !modelMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        closeToolbarMenus()
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [commandMenuOpen, permissionMenuOpen, modelMenuOpen, closeToolbarMenus])

  // 点击视图选项外部时收起下拉（sidebar 独立容器，不在 toolbarRef 内）。
  useEffect(() => {
    if (!viewSortOpen) return
    const onDown = (e: MouseEvent) => {
      if (viewSortRef.current && !viewSortRef.current.contains(e.target as Node)) {
        setViewSortOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [viewSortOpen])

  /** 切换工作区展开/收起。 */
  const toggleWorkspace = useCallback((workspaceId: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])

  // 消息流滚动：仅在「当前位于底部」时才自动跟随新消息/流式增量（对齐官方 atBottomRef），
  // 用户上滚过则不打扰（不回到底部）。阈值 25px（对齐官方 isAtBottom）。
  const isAtBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 25
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
    atBottomRef.current = true
  }, [])

  // 会话树「分支」：以当前会话为源新建子会话（session.fork，不带 atSeq = 默认最后完成轮次）。
  const forkSessionById = useCallback(
    async (sessionId: string) => {
      const res = await deepcClient.call("session.fork", { sessionId })
      if (res.ok) await loadWorkspace()
    },
    [loadWorkspace]
  )

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isStreaming])

  // 监听滚动位置，实时更新 atBottom（用于显示「回到底部」浮层按钮）。
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      const bottom = isAtBottom(el)
      atBottomRef.current = bottom
      setAtBottom(bottom)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [isAtBottom])

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId)

  // 读某个 namespace 的 resolved value（对象）。
  const settingValue = useCallback(
    (ns: string): Record<string, unknown> | undefined => {
      const view = settings?.namespaces.find((n) => n.ns === ns)
      if (view && typeof view.value === "object" && view.value !== null) {
        return view.value as Record<string, unknown>
      }
      return undefined
    },
    [settings]
  )

  // 设置页当前值（真实动态值；未读到则回退默认）。
  const permission = (settingValue("permission")?.defaultPreset as string) ?? "workspace-write"
  const locale = (settingValue("locale")?.preference as string) ?? "zh"
  const theme = (settingValue("ui-theme")?.preference as string) ?? "system"
  const busyEnter = (settingValue("ui-conversation")?.busyEnter as string) ?? "queue"
  const defaultModel =
    (settingValue("agent-default-model")?.model as string) ?? model?.model ?? ""

  // 写入回调：成功返回 true；失败静默。
  const setPref = useCallback(
    (ns: string, patch: Record<string, unknown>) => {
      void updateSetting(ns, patch)
    },
    [updateSetting]
  )

  // 读取远端 settings 配置文件原文，并切到只读整页展示。
  const openSettingsDoc = useCallback(async () => {
    const doc = await readSettingsDocument()
    if (doc) setSettingsDoc(doc)
  }, [readSettingsDocument])

  // 会话统计（turns/steps），来自 session.list 的 sessionStats projection。
  const sessionStats = useMemoStats(activeSession)

  // ── composer 工具栏：会话模型（session.models）派生 ───────────────────
  const currentModel = sessionModels?.current ?? model ?? null
  const modelOptions = useMemoModelOptions(sessionModels)
  const currentModelEntry = useMemo(() => modelOptions.find((m) => m.id === currentModel?.model), [modelOptions, currentModel])
  const reasoningEfforts = useMemo(() => currentModelEntry?.reasoning?.efforts ?? [], [currentModelEntry])

  // 访问模式当前值 + 显示 label。
  const accessModeLabel = ACCESS_MODES.find((m) => m.value === permission)?.label ?? permission

  // 按搜索词过滤工作区会话。
  const keyword = searchQuery.trim().toLowerCase()
  const filteredWorkspaces = useMemo(() => {
    if (!keyword) return workspaces
    return workspaces
      .map((ws) => ({
        ...ws,
        sessionIds: ws.sessionIds.filter((id) => {
          const s = sessions.find((x) => x.sessionId === id)
          if (!s) return false
          const dir = s.cwd ? s.cwd.split(/[\\/]/).pop() || "" : ""
          return dir.toLowerCase().includes(keyword)
        }),
      }))
      .filter((ws) => ws.sessionIds.length > 0)
  }, [workspaces, sessions, keyword])

  // 分组渲染时隐藏 blank + 归档会话（官方 sessionVisible 语义）：
  //   · 隐藏 blank，但保留当前选中的「临时新建」行（blank 才有 current 例外）
  //   · 隐藏 archived（归档后即从 sidebar 消失，**无 current 例外**）
  //   · parentSessionId 分叉子会话不隐藏
  const visibleSessions = useCallback((wsSessionIds: string[]) => {
    const list = wsSessionIds
      .map((id) => sessions.find((s) => s.sessionId === id))
      .filter((s): s is SessionSummary => Boolean(s))
      .filter((s) => !s.blank || s.sessionId === activeSessionId)
      .filter((s) => !archivedSessionIds.has(s.sessionId))
    if (viewSort.orderBy === "updated") {
      return list.toSorted((a, b) => b.updatedAt - a.updatedAt)
    }
    return list
  }, [sessions, activeSessionId, archivedSessionIds, viewSort.orderBy])

  const handleSend = async () => {
    const text = draft.trim()
    if (!text) return
    // 清空 contenteditable 的实际 DOM 文本（draft 是受控 state，但 DOM 非受控，
    // 只 setDraft("") 不会清掉编辑器里的字，导致「已发送消息卡在输入框」）。
    if (editorRef.current) editorRef.current.textContent = ""
    setDraft("")
    await sendPrompt(text)
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      {/* chatUI 工作区：装载在站点统一容器（居中 + 最大宽 + 圆角边框），
          不再左右直接到顶，符合子页面容器定位 */}
      <div
        className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background"
        style={{ height: `calc(100dvh - ${TOPBAR_H}px - 3rem)` }}
      >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── 左：侧栏（复刻官方 hHd-Xa）────────────────────────────── */}
        {sidebarCollapsed ? (
          <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border/60 bg-sidebar py-3 gap-1.5">
            <img
              src="/deepseek.svg"
              alt=""
              aria-hidden
              className="size-6 shrink-0 opacity-90 dark:invert"
            />
            <div className="mt-4 flex flex-col items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                onClick={() => void createSession(activeSession?.cwd ?? workspaces[0]?.path)}
                title="新建会话"
              >
                <MessageSquarePlus className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                onClick={() => setFolderPickerOpen(true)}
                title="添加工作区"
              >
                <Plus className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                onClick={() => setSearchActive(true)}
                title="搜索会话"
              >
                <Search className="size-4" />
              </Button>
            </div>
          </aside>
        ) : (
          <aside className="flex w-70 shrink-0 flex-col border-r border-border/60 bg-sidebar">
            {/* 品牌行 + 收起 */}
            <div className="flex h-15 shrink-0 items-center justify-between px-3">
              <div className="flex min-w-0 items-center gap-2 px-1">
                <img
                  src="/deepseek.svg"
                  alt=""
                  aria-hidden
                  className="size-5 shrink-0 opacity-90 dark:invert"
                />
                <span className="truncate text-sm font-semibold text-sidebar-foreground">
                  {hostInfo?.hostname ?? "deepSea"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                onClick={() => setSidebarCollapsed(true)}
                title="收起侧栏"
              >
                <PanelLeft className="size-4" />
              </Button>
            </div>

            {/* 新建会话 */}
            <div className="shrink-0 px-3">
              <Button
                variant="secondary"
                className="flex w-full items-center justify-center gap-2"
                onClick={() => void createSession(activeSession?.cwd ?? workspaces[0]?.path)}
              >
                <MessageSquarePlus className="size-4" />
                新建会话
              </Button>
            </div>

            {/* 工作区：标签 + 搜索/视图选项/添加工作区 三按钮（搜索激活时整行替换为搜索框） */}
            <div className="mt-2 flex shrink-0 items-center gap-1 px-3">
              {searchActive ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索会话…"
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setSearchActive(false)
                      setSearchQuery("")
                    }}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    title="关闭搜索"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-sm text-muted-foreground">工作区</span>
                  <div className="ml-auto flex items-center gap-1">
                    {/* 搜索会话 */} 
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      onClick={() => setSearchActive(true)}
                      title="搜索会话"
                    >
                      <Search className="size-4" />
                    </Button>
                    {/* 视图选项（排列） */}
                    <div className="relative" ref={viewSortRef}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn("size-7 text-muted-foreground", viewSortOpen && "bg-muted/60")}
                        onClick={() => setViewSortOpen((v) => !v)}
                        title="视图选项"
                      >
                        <ListOrdered className="size-4" />
                      </Button>
                      {viewSortOpen && (
                        <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
                          <ViewSortMenu
                            value={viewSort}
                            onChange={(v) => {
                              setViewSort(v)
                              writeViewSort(v)
                              setViewSortOpen(false)
                            }}
                          />
                        </div>
                      )}
                    </div>
                    {/* 添加工作区 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      onClick={() => setFolderPickerOpen(true)}
                      title="添加工作区"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* 会话树 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filteredWorkspaces.length === 0 && !keyword ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">暂无会话</p>
              ) : filteredWorkspaces.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">无匹配会话</p>
              ) : viewSort.groupBy === "flat" ? (
                (() => {
                  // 平铺模式：跨工作区汇总所有会话，不区分分组。
                  const allIds = filteredWorkspaces.flatMap((ws) => ws.sessionIds)
                  const flatSessions = visibleSessions(allIds)
                  if (flatSessions.length === 0) {
                    return (
                      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                        无匹配会话
                      </p>
                    )
                  }
                  return (
                    <FlatSessionTree
                      sessions={flatSessions}
                      activeSessionId={activeSessionId}
                      onSelect={selectSession}
                      onRename={(id) => {
                        const s = sessions.find((x) => x.sessionId === id)
                        const next = window.prompt("重命名会话", s ? sessionTitle(s) : undefined)
                        if (next?.trim()) void renameSession(id, next.trim())
                      }}
                      onFork={(id) => void forkSessionById(id)}
                      onArchive={(id) => void archiveSession(id)}
                    />
                  )
                })()
              ) : (
                filteredWorkspaces.map((ws) => {
                  const wsSessions = visibleSessions(ws.sessionIds)
                  return (
                    <div key={ws.workspaceId} className="mb-1">
                      <div className="group flex w-full items-center gap-1.5 rounded-lg text-sidebar-foreground transition-colors hover:bg-muted/60">
                        <button
                          type="button"
                          onClick={() => toggleWorkspace(ws.workspaceId)}
                          className="flex h-8.5 min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3.5 shrink-0 text-muted-foreground transition-transform",
                              !collapsedWorkspaces.has(ws.workspaceId) && "rotate-90"
                            )}
                          />
                          <Folder className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {ws.title || ws.path}
                          </span>
                        </button>
                        {/* 更多菜单按钮（hover 显现） */}
                        <div className="relative mr-1">
                          <button
                            type="button"
                            title="更多"
                            onClick={() => setWsMenuId(wsMenuId === ws.workspaceId ? null : ws.workspaceId)}
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-colors hover:bg-muted/60 hover:text-foreground group-hover:opacity-100",
                              wsMenuId === ws.workspaceId && "opacity-100 bg-muted/60"
                            )}
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                          {wsMenuId === ws.workspaceId && (
                            <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                                onClick={() => {
                                  const next = window.prompt("重命名工作区", ws.title || ws.path)
                                  if (next?.trim()) void renameWorkspace(ws.workspaceId, next.trim())
                                  setWsMenuId(null)
                                }}
                              >
                                <Pencil className="size-3.5" /> 重命名
                              </button>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-rose-400 transition-colors hover:bg-muted/60"
                                onClick={() => {
                                  if (window.confirm(`删除工作区「${ws.title || ws.path}」？`)) {
                                    void deleteWorkspace(ws.workspaceId)
                                  }
                                  setWsMenuId(null)
                                }}
                              >
                                <Trash2 className="size-3.5" /> 删除工作区
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      {!collapsedWorkspaces.has(ws.workspaceId) &&
                        wsSessions.map((s) => (
                          <SessionRow
                            key={s.sessionId}
                            session={s}
                            active={activeSessionId === s.sessionId}
                            onSelect={selectSession}
                            onRename={(id) => {
                              const next = window.prompt("重命名会话", sessionTitle(s))
                              if (next?.trim()) void renameSession(id, next.trim())
                            }}
                            onFork={(id) => void forkSessionById(id)}
                            onArchive={(id) => void archiveSession(id)}
                          />
                        ))}
                    </div>
                  )
                })
              )}
            </div>

            {/* 底部：设置（为主）+ 极简连接状态（靠右） */}
            <div className="shrink-0 border-t border-border/60 p-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-sm text-muted-foreground"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings className="size-4" />
                  设置
                </Button>
                <div className="ml-auto shrink-0">
                  <ConnectStatus state={state} elapsed={elapsed} onDisconnect={onDisconnect} />
                </div>
              </div>
            </div>
          </aside>
        )}

        {/* ── 中：聊天区 ───────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col bg-background">
          {/* header：会话标题 + 状态 */}
          <div className="flex h-15 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4">
            <div className="flex min-w-0 items-center gap-2">
              {sidebarCollapsed && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  onClick={() => setSidebarCollapsed(false)}
                  title="展开侧栏"
                >
                  <PanelLeft className="size-4" />
                </Button>
              )}
              <span className="truncate text-sm font-medium">
                {activeSession ? sessionLabel(activeSession) : "多端互联"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                onClick={() => void refreshAll()}
                title="刷新"
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </div>

          {/* 消息流（滚动体 + 回到底部浮层按钮） */}
          <div className="relative min-h-0 flex-1">
            <div ref={viewportRef} className="h-full overflow-y-auto px-4 py-4">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  加载会话…
                </div>
              ) : messages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                    <Waves className="size-6 text-primary" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">开始一段对话</p>
                    <p className="text-xs text-muted-foreground">
                      选择左侧会话继续，或发送第一条消息开始
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mx-auto max-w-3xl">
                  <ChatMessageList
                    nodes={messages}
                    onFork={(atSeq: number) => void forkSession(atSeq)}
                  />
                  {isStreaming && (
                    <div className="flex items-center gap-2 py-2 pl-9 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      正在生成…
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* 回到底部浮层按钮（上下滚动超过 25px 时显示，对齐官方 toBottomSlot） */}
            {!atBottom && !loading && (
              <button
                type="button"
                onClick={scrollToBottom}
                title="回到底部"
                className="absolute bottom-4 right-4 z-20 flex size-8 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-md backdrop-blur transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <ChevronDown className="size-4" />
              </button>
            )}
          </div>

          {/* 输入框（composer · border-t 容器） */}
          <div className="shrink-0 border-t border-border/60">
            {pendingInteractions.length > 0 && (
              <div className="mx-auto max-w-3xl px-4 pt-2.5">
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  <CircleAlert className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {pendingInteractions[0].kind === "question"
                      ? "等待回答：请在下方回答问题"
                      : `等待授权：${pendingInteractions[0].toolName ?? ""}`}
                  </span>
                </div>
              </div>
            )}
            <div className="mx-auto max-w-3xl px-4 pt-2.5 pb-1.5">
              <div className="rounded-xl border border-border/80 bg-muted/40 px-3 py-2 transition-colors focus-within:border-ring">
                <div
                  ref={editorRef}
                  contentEditable={!!activeSessionId}
                  suppressContentEditableWarning
                  data-placeholder={activeSessionId ? "发送消息…" : "请先选择会话"}
                  data-empty={!draft}
                  className="min-h-10 w-full resize-none border-0 bg-transparent px-0 py-0 text-sm leading-6 text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)] [&_mark]:rounded [&_mark]:bg-primary/15 [&_mark]:px-0.5 [&_mark]:text-foreground"
                onInput={(e) => {
                  const text = (e.target as HTMLDivElement).textContent ?? ""
                  setDraft(text)
                  void handleSlashEdit(text)
                }}
                onKeyDown={(e) => {
                  // Esc 收起 / 联想。
                  if (e.key === "Escape" && slashOpen) {
                    setSlashOpen(false)
                    setSlashItems([])
                    return
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
                />
              </div>
              {/* 输入框 / 命令联想下拉 */}
              {slashOpen && activeSessionId && (
                <div
                  ref={slashRef}
                  className="absolute inset-x-4 z-30 mx-auto max-w-3xl overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl"
                  style={{ bottom: "calc(100% + 8px)" }}
                >
                  <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    命令
                  </p>
                  {slashLoading ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      加载命令…
                    </div>
                  ) : slashItems.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">无匹配命令</p>
                  ) : (
                    slashItems.map((c) => {
                      // 高亮命令名中匹配查询的子串（对齐官方联想高亮）。
                      const q = slashQuery
                      const idx = q ? c.name.toLowerCase().indexOf(q) : -1
                      const name = `/${c.name}`
                      const matched = idx >= 0
                        ? (
                            <>
                              {name.slice(0, idx + 1)}
                              <mark className="rounded-sm bg-primary/20 px-0.5 text-primary">
                                {name.slice(idx + 1, idx + 1 + q.length)}
                              </mark>
                              {name.slice(idx + 1 + q.length)}
                            </>
                          )
                        : name
                      return (
                        <button
                          key={c.name}
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                          onClick={() => {
                            insertCommand(c.name)
                            setSlashOpen(false)
                            setSlashItems([])
                          }}
                        >
                          <span className="font-mono text-xs font-medium text-foreground">{matched}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {c.description}
                          </span>
                          {c.hint && <span className="shrink-0 text-[10px] text-muted-foreground/60">{c.hint}</span>}
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>
            <div className="mx-auto max-w-3xl px-4">
              <div ref={toolbarRef} className="flex items-center justify-between gap-2 pb-1.5">
                <div className="flex items-center gap-1">
                  {/* 命令按钮（+） */}
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      title="命令"
                      onClick={() => {
                        setCommandMenuOpen((v) => !v)
                        setPermissionMenuOpen(false)
                        setModelMenuOpen(false)
                      }}
                    >
                      <Plus className="size-4" />
                    </Button>
                    {commandMenuOpen && (
                      <div className="absolute bottom-full left-0 z-30 mb-1 w-72 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
                        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          命令
                        </p>
                        {SLASH_COMMANDS.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                            onClick={() => {
                              if (c.id === "model") setModelMenuOpen(true)
                              else if (c.id === "permission") setPermissionMenuOpen(true)
                              else if (activeSessionId) insertCommand(c.id)
                            }}
                          >
                            <span className="text-xs font-medium text-foreground">{c.name}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {c.desc}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 访问模式 */}
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 text-xs text-muted-foreground"
                      title={`访问模式，当前：${accessModeLabel}`}
                      onClick={() => {
                        setPermissionMenuOpen((v) => !v)
                        setCommandMenuOpen(false)
                        setModelMenuOpen(false)
                      }}
                    >
                      {accessModeLabel}
                      <ChevronDown className="size-3.5" />
                    </Button>
                    {permissionMenuOpen && (
                      <div className="absolute bottom-full left-0 z-30 mb-1 w-48 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
                        {ACCESS_MODES.map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            className={cn(
                              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                              m.value === permission ? "text-foreground" : "text-muted-foreground"
                            )}
                            onClick={() => {
                              setPermissionMenuOpen(false)
                              setPref("permission", { defaultPreset: m.value })
                            }}
                          >
                            {m.label}
                            {m.value === permission && <span className="text-emerald-400">✓</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center text-xs text-muted-foreground/70">
                  {sessionStats.turns} 轮 · {sessionStats.steps} 步
                </div>

                <div className="flex items-center gap-1">
                  {/* 模型选择 */}
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 text-xs text-muted-foreground"
                      title={`选择模型，当前 ${currentModelEntry?.name ?? currentModel?.model ?? "选择模型"}，推理等级 ${currentModel?.reasoningEffort ?? "-"}`}
                      onClick={() => {
                        setModelMenuOpen((v) => !v)
                        setCommandMenuOpen(false)
                        setPermissionMenuOpen(false)
                      }}
                    >
                      {currentModelEntry?.name ?? currentModel?.model ?? "选择模型"}
                      <ChevronDown className="size-3.5" />
                    </Button>
                    {modelMenuOpen && (
                      <div className="absolute bottom-full right-0 z-30 mb-1 w-56 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
                        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          模型
                        </p>
                        {modelOptions.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className={cn(
                              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                              m.id === currentModel?.model ? "text-foreground" : "text-muted-foreground"
                            )}
                            onClick={() => {
                              if (activeSessionId) {
                                void selectSessionModel(activeSessionId, m.provider, m.id, currentModel?.reasoningEffort)
                              }
                            }}
                          >
                            {m.name}
                            {m.id === currentModel?.model && <span className="text-emerald-400">✓</span>}
                          </button>
                        ))}
                        {reasoningEfforts.length > 0 && (
                          <>
                            <p className="mt-1 border-t border-border/40 px-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              推理等级
                            </p>
                            {reasoningEfforts.map((e) => (
                              <button
                                key={e.id}
                                type="button"
                                className={cn(
                                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                                  e.id === currentModel?.reasoningEffort ? "text-foreground" : "text-muted-foreground"
                                )}
                                onClick={() => {
                                  if (activeSessionId && currentModel) {
                                    void selectSessionModel(activeSessionId, currentModel.provider, currentModel.model, e.id)
                                  }
                                }}
                              >
                                {e.name}
                                {e.id === currentModel?.reasoningEffort && <span className="text-emerald-400">✓</span>}
                              </button>
                            ))}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <Button
                    onClick={() => void handleSend()}
                    disabled={!activeSessionId || !draft.trim()}
                    size="icon"
                    className="size-7"
                    title="发送消息"
                  >
                    <SendHorizonal className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>

      {/* 虚拟文件夹选择窗口 */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={(path) => {
          setFolderPickerOpen(false)
          void createSession(path)
        }}
        homePath={hostInfo?.home}
      />

      {/* 设置面板（复刻官方 dialog） */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSettingsOpen(false)} />
          <div className="relative flex h-150 w-180 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
            <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-border/60 p-3">
              <p className="px-3 pb-2 text-sm font-semibold">设置</p>
              {SETTINGS_NAV.map((item) => (
                <SettingsNavItem
                  key={item.id}
                  label={item.label}
                  active={settingsTab === item.id}
                  onClick={() => setSettingsTab(item.id)}
                />
              ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              {settingsDoc ? (
                <SettingsDocumentView doc={settingsDoc} onBack={() => setSettingsDoc(null)} />
              ) : (
                <>
              <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
                <span className="text-sm font-medium">
                  {SETTINGS_NAV.find((i) => i.id === settingsTab)?.label}
                </span>
                <div className="flex items-center gap-2">
                  {settingsTab === "general" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => void openSettingsDoc()}
                    >
                      打开配置文件
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    onClick={() => setSettingsOpen(false)}
                    title="关闭"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {settingsTab === "general" && (
                  <>
                    <SettingsRow
                      title="权限"
                      desc="选择新会话的默认权限模式"
                      value={permission}
                      options={PERMISSION_OPTIONS}
                      onSelect={(v) => setPref("permission", { defaultPreset: v })}
                    />
                    <SettingsRow
                      title="语言"
                      value={locale}
                      options={LOCALE_OPTIONS}
                      onSelect={(v) => setPref("locale", { preference: v })}
                    />
                    <SettingsRow
                      title="外观"
                      value={theme}
                      options={THEME_OPTIONS}
                      onSelect={(v) => setPref("ui-theme", { preference: v })}
                    />
                    <SettingsRow
                      title="繁忙时 Enter 键行为"
                      desc="仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为"
                      value={busyEnter}
                      options={ENTER_OPTIONS}
                      onSelect={(v) => setPref("ui-conversation", { busyEnter: v })}
                    />
                  </>
                )}

                {settingsTab === "models" && (
                  <>
                    <p className="pb-1 text-xs text-muted-foreground">
                      新会话默认使用的模型（agent-default-model）
                    </p>
                    {modelCatalog.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        未获取到可用模型目录
                      </div>
                    ) : (
                      modelCatalog.map((m) => (
                        <SettingsRow
                          key={m.id}
                          title={m.name}
                          desc={`id: ${m.id}${m.contextWindow ? ` · 上下文 ${m.contextWindow.toLocaleString()}` : ""}`}
                          value={m.id}
                          selected={m.id === defaultModel}
                          onSelectValue={() =>
                            setPref("agent-default-model", {
                              provider: settingValue("agent-default-model")?.provider ?? "deepseek-official",
                              model: m.id,
                            })
                          }
                        />
                      ))
                    )}
                  </>
                )}

                {settingsTab === "plugins" && (
                  <>
                    <p className="pb-1 text-xs text-muted-foreground">
                      由 Host Loader 提供的插件清单（共 {plugins.length} 项，按启用状态排序）
                    </p>
                    {!pluginsLoaded ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        加载插件清单…
                      </div>
                    ) : plugins.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">无插件</div>
                    ) : (
                      [...plugins]
                        .toSorted((a, b) => Number(b.enabled) - Number(a.enabled))
                        .map((p) => (
                          <div
                            key={p.entryId}
                            className="flex items-center justify-between gap-3 border-b border-border/40 py-2"
                          >
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate font-mono text-xs",
                                p.enabled ? "text-foreground" : "text-muted-foreground/60"
                              )}
                            >
                              {p.moduleName}
                            </span>
                            <Badge
                              variant="outline"
                              className={cn(
                                "shrink-0 border-transparent text-[10px]",
                                p.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-500/15 text-slate-400"
                              )}
                            >
                              {p.enabled ? "启用" : "禁用"}
                            </Badge>
                            <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground">
                              {p.fiberPhase ? PLUGIN_PHASE_LABEL[p.fiberPhase] ?? p.fiberPhase : "未挂载"}
                            </span>
                          </div>
                        ))
                    )}
                  </>
                )}

                {settingsTab === "presets" && (
                  <AgentPresetsSection
                    presets={agentPresets?.presets ?? []}
                    authorable={agentPresets?.authorable ?? false}
                    loading={agentPresets === null}
                    onLoad={loadAgentPresets}
                    onSelectDefault={setDefaultAgentPreset}
                    onView={readAgentPreset}
                    onCopy={copyAgentPreset}
                    onRemove={removeAgentPreset}
                  />
                )}
              </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

/** 会话统计（turns/steps）。 */
function useMemoStats(activeSession: SessionSummary | undefined) {
  return useMemo(() => {
    const stats = (activeSession?.projections?.values?.sessionStats as
      | { turns?: number; steps?: number }
      | undefined) ?? undefined
    return { turns: stats?.turns ?? 0, steps: stats?.steps ?? 0 }
  }, [activeSession])
}

/** 从 sessionModels 扁平化出可选模型列表。 */
function useMemoModelOptions(
  sessionModels: ReturnType<typeof useDeepcLink>["sessionModels"]
) {
  return useMemo(() => {
    const list: {
      provider: string
      id: string
      name: string
      reasoning?: { efforts?: { id: string; name: string }[]; defaultEffort?: string }
    }[] = []
    for (const g of sessionModels?.groups ?? []) {
      for (const m of g.models) {
        list.push({ provider: g.id, id: m.id, name: m.name, reasoning: m.reasoning })
      }
    }
    return list
  }, [sessionModels])
}

/** 排列菜单的选项行。 */
function SortOption({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
        active ? "bg-muted/70 text-foreground" : "text-muted-foreground hover:bg-muted/40"
      )}
    >
      <span className="min-w-0 flex-1">{label}</span>
      {active && <span className="shrink-0 text-emerald-400">✓</span>}
    </button>
  )
}

/** 会话视图排列菜单（groupBy / orderBy）。 */
function ViewSortMenu({
  value,
  onChange,
}: {
  value: ViewSort
  onChange: (v: ViewSort) => void
}) {
  return (
    <div className="space-y-0.5">
      <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        分组
      </p>
      <SortOption
        active={value.groupBy === "workspace"}
        label="按工作区"
        onClick={() => onChange({ ...value, groupBy: "workspace" })}
      />
      <SortOption
        active={value.groupBy === "flat"}
        label="扁平"
        onClick={() => onChange({ ...value, groupBy: "flat" })}
      />
      <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        排序
      </p>
      <SortOption
        active={value.orderBy === "manual"}
        label="手动"
        onClick={() => onChange({ ...value, orderBy: "manual" })}
      />
      <SortOption
        active={value.orderBy === "updated"}
        label="最近更新"
        onClick={() => onChange({ ...value, orderBy: "updated" })}
      />
    </div>
  )
}

/** 平铺会话树：所有会话跨工作区平铺显示（viewSort.groupBy==='flat'）。 */
function FlatSessionTree({
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onFork,
  onArchive,
}: {
  sessions: SessionSummary[]
  activeSessionId: string | null | undefined
  onSelect: (id: string) => void
  onRename?: (id: string) => void
  onFork?: (id: string) => void
  onArchive?: (id: string) => void
}) {
  if (sessions.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">无匹配会话</p>
  }
  return (
    <div className="mb-1">
      {sessions.map((s) => (
        <SessionRow
          key={s.sessionId}
          session={s}
          active={activeSessionId === s.sessionId}
          onSelect={onSelect}
          onRename={onRename}
          onFork={onFork}
          onArchive={onArchive}
        />
      ))}
    </div>
  )
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** 时间格式化（YYYY-MM-DD HH:mm，供配置文件「更新于」提示）。 */
function formatMtime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 配置文件只读整页展示：标题返回按钮 + 提示「来自哪个节点 / 更新于什么时间」。 */
function SettingsDocumentView({ doc, onBack }: { doc: SettingsDocumentView; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={onBack}>
          <ChevronLeft className="size-4" />
          返回设置
        </Button>
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <FileText className="size-4 text-muted-foreground" />
          配置文件
        </span>
        <span className="ml-auto truncate text-xs text-muted-foreground" title={doc.path}>
          来自 {doc.hostname} · 更新于 {formatMtime(doc.mtime)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/90">
          {doc.content}
        </pre>
      </div>
    </div>
  )
}

/** Agent 预设管理（复刻官方：卡片列表 + 设为默认 + 复制 + 只读查看 + 删除）。 */
function AgentPresetsSection({
  presets,
  authorable,
  loading,
  onLoad,
  onSelectDefault,
  onView,
  onCopy,
  onRemove,
}: {
  presets: AgentPresetEntry[]
  authorable: boolean
  loading: boolean
  onLoad: () => void
  onSelectDefault: (id: string) => Promise<boolean>
  onView: (id: string) => Promise<AgentPresetReadResult | null>
  onCopy: (from: string, id: string, name?: string) => Promise<boolean>
  onRemove: (id: string) => Promise<boolean>
}) {
  const [view, setView] = useState<AgentPresetReadResult | null>(null)
  const [copyFrom, setCopyFrom] = useState<AgentPresetEntry | null>(null)
  const [copyId, setCopyId] = useState("")
  const [copyName, setCopyName] = useState("")
  const [copySaving, setCopySaving] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // 首次渲染（切到本 tab）即加载 roster。
  useEffect(() => {
    onLoad()
  }, [onLoad])

  const submitCopy = async () => {
    if (!copyFrom || !copyId.trim()) return
    setCopySaving(true)
    setCopyError(null)
    const ok = await onCopy(copyFrom.id, copyId.trim(), copyName.trim() || undefined)
    setCopySaving(false)
    if (ok) {
      setCopyFrom(null)
      setCopyId("")
      setCopyName("")
    } else {
      setCopyError("复制失败（id 可能已占用或部署不可写）")
    }
  }

  const confirmRemove = async () => {
    if (!deleteId) return
    setDeleting(true)
    await onRemove(deleteId)
    setDeleting(false)
    setDeleteId(null)
  }

  const openView = async (id: string) => {
    const r = await onView(id)
    if (r) setView(r)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载预设…
      </div>
    )
  }

  if (presets.length === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">未配置任何预设</div>
  }

  return (
    <div className="space-y-1">
      <p className="pb-1 text-xs text-muted-foreground">
        决定新会话的智能体组成。运行中的会话保持它开始时的预设。
      </p>
      {presets.map((p) => (
        <div key={p.id} className="flex items-center gap-3 border-b border-border/40 py-2.5">
          <button
            type="button"
            disabled={p.isDefault || !!p.broken}
            onClick={() => void onSelectDefault(p.id)}
            title={p.isDefault ? "当前默认" : "设为默认"}
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
              p.isDefault
                ? "border-primary bg-primary"
                : "border-muted-foreground/40 hover:border-primary/60",
              p.broken && "opacity-40"
            )}
          >
            {p.isDefault && <span className="size-1.5 rounded-full bg-primary-foreground" />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm text-foreground">{p.name ?? p.id}</span>
              {p.name && <span className="shrink-0 font-mono text-xs text-muted-foreground">{p.id}</span>}
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 border-transparent text-[10px]",
                  p.trust === "system" ? "bg-slate-500/15 text-slate-400" : "bg-amber-500/15 text-amber-400"
                )}
              >
                {p.trust === "system" ? "内置" : "自定义"}
              </Badge>
              {p.isDefault && (
                <Badge variant="outline" className="shrink-0 border-transparent bg-emerald-500/15 text-[10px] text-emerald-400">
                  默认
                </Badge>
              )}
            </div>
            {p.description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.description}</p>
            )}
            {p.broken && <p className="mt-0.5 text-xs text-rose-400">不可用：{p.broken}</p>}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => void openView(p.id)}
              title="查看 composition"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Eye className="size-3.5" />
            </button>
            {authorable && (
              <button
                type="button"
                onClick={() => {
                  setCopyFrom(p)
                  setCopyId("")
                  setCopyName("")
                  setCopyError(null)
                }}
                title="复制为自定义预设"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </button>
            )}
            {p.trust === "user" && (
              <button
                type="button"
                onClick={() => setDeleteId(p.id)}
                title="删除"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-rose-400"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      ))}

      {/* 只读查看 composition */}
      {view && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setView(null)} />
          <div className="relative flex h-130 w-160 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
              <span className="text-sm font-medium">{view.name ?? view.agentPreset}</span>
              <Badge variant="outline" className="border-transparent text-[10px]">
                {view.trust === "system" ? "内置" : "自定义"}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-7 text-muted-foreground"
                onClick={() => setView(null)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/90">
                {view.content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* 复制对话框 */}
      {copyFrom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setCopyFrom(null)} />
          <div className="relative flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-2xl border border-border/60 bg-background p-4 shadow-2xl">
            <p className="text-sm font-semibold">复制预设：{copyFrom.name ?? copyFrom.id}</p>
            <label className="text-xs text-muted-foreground">
              新预设 id（目录名，必填）
              <input
                value={copyId}
                onChange={(e) => setCopyId(e.target.value)}
                placeholder="my-preset"
                className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-ring"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              显示名（可选，空则回退 id）
              <input
                value={copyName}
                onChange={(e) => setCopyName(e.target.value)}
                placeholder="My preset"
                className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-ring"
              />
            </label>
            {copyError && <p className="text-xs text-rose-400">{copyError}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCopyFrom(null)}>
                取消
              </Button>
              <Button size="sm" disabled={!copyId.trim() || copySaving} onClick={() => void submitCopy()}>
                {copySaving ? "复制中…" : "复制"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteId(null)} />
          <div className="relative flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-2xl border border-border/60 bg-background p-4 shadow-2xl">
            <p className="text-sm font-semibold">删除预设</p>
            <p className="text-xs text-muted-foreground">
              确定删除自定义预设「{deleteId}」吗？已按它组成的会话不受影响。
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDeleteId(null)}>
                取消
              </Button>
              <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void confirmRemove()}>
                {deleting ? "删除中…" : "删除"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 设置导航项。 */
function SettingsNavItem({
  label,
  active,
  onClick,
}: {
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
        active ? "bg-muted/60 text-foreground" : "text-muted-foreground hover:bg-muted/40"
      )}
    >
      {label}
    </button>
  )
}

/** 设置项行：标题 + 描述 + 当前值（可点选枚举 / 下拉 / 单选样式）。 */
function SettingsRow({
  title,
  desc,
  value,
  options,
  onSelect,
  selected,
  onSelectValue,
}: {
  title: string
  desc?: string
  value: string
  options?: { value: string; label: string }[]
  onSelect?: (value: string) => void
  selected?: boolean
  onSelectValue?: () => void
}) {
  if (onSelectValue) {
    return (
      <button
        type="button"
        onClick={onSelectValue}
        className={cn(
          "flex w-full items-center justify-between gap-4 border-b border-border/40 py-3 text-left transition-colors",
          selected ? "bg-muted/40" : "hover:bg-muted/20"
        )}
      >
        <div className="min-w-0">
          <p className="text-sm text-foreground">{title}</p>
          {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
        </div>
        {selected && <span className="shrink-0 text-xs text-emerald-400">当前</span>}
      </button>
    )
  }
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/40 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{title}</p>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {options ? (
        <div className="flex shrink-0 items-center gap-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect?.(opt.value)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs transition-colors",
                opt.value === value ? "bg-muted/70 text-foreground" : "text-muted-foreground hover:bg-muted/40"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted/40"
        >
          {value}
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}

/** 会话行（复刻官方）。 */
function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onFork,
  onArchive,
}: {
  session: SessionSummary
  active: boolean
  onSelect: (id: string) => void
  onRename?: (id: string) => void
  onFork?: (id: string) => void
  onArchive?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="group relative flex h-8 w-full items-center gap-1.5 rounded-lg pr-1 pl-7 text-left text-sm transition-colors hover:bg-muted/60">
      <button
        type="button"
        onClick={() => void onSelect(session.sessionId)}
        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            active ? "text-foreground" : "text-foreground/80"
          )}
        >
          {sessionTitle(session)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(session.updatedAt)}
        </span>
      </button>
      {/* 更多菜单（hover 显现） */}
      {!session.blank && (
        <div className="relative">
          <button
            type="button"
            title="更多"
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-colors hover:bg-muted/60 hover:text-foreground focus:opacity-100 group-hover:opacity-100",
              open && "opacity-100 bg-muted/60"
            )}
          >
            <MoreHorizontal className="size-4" />
          </button>
          {open && (
            <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                onClick={() => {
                  setOpen(false)
                  onRename?.(session.sessionId)
                }}
              >
                <Pencil className="size-3.5" /> 重命名
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                onClick={() => {
                  setOpen(false)
                  onFork?.(session.sessionId)
                }}
              >
                <GitBranch className="size-3.5" /> 分叉会话
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                onClick={() => {
                  setOpen(false)
                  onArchive?.(session.sessionId)
                }}
              >
                <Archive className="size-3.5" /> 归档会话
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 会话真实标题：session/title 事件投影（last-wins，基于首条用户消息）。 */
function sessionTitleOf(s: SessionSummary): string | null {
  const t = s.projections?.values?.title
  return typeof t === "string" && t.trim() ? t : null
}

/** 会话标题：优先投影 title；空白会话「新会话」；否则 cwd 目录名。 */
function sessionTitle(s: SessionSummary): string {
  const t = sessionTitleOf(s)
  if (t) return t
  if (s.blank) return "新会话"
  return s.cwd ? s.cwd.split(/[\\/]/).pop() || "会话" : "会话"
}

/** 会话行 label（header 展示用）：标题 + 相对时间。 */
function sessionLabel(s: SessionSummary): string {
  return `${sessionTitle(s)} · ${relativeTime(s.updatedAt)}`
}

/** 相对时间（复刻官方「X分钟/X小时/X天」）。 */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min}分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时`
  const day = Math.floor(hr / 24)
  return `${day}天`
}
