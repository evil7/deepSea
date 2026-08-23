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
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Folder,
  ListOrdered,
  Loader2,
  MessageSquarePlus,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  SendHorizonal,
  Settings,
  Waves,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChatMessageList } from "@/components/link/chat-message"
import { FolderPicker } from "@/components/link/folder-picker"
import { ConnectStatus } from "@/components/link/connect-status"
import { useDeepcLink } from "@/hooks/use-deepc-link"
import { cn } from "@/lib/utils"
import type { SessionSummary } from "@/lib/deepc-link/protocol"

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
    activeSessionId,
    messages,
    isStreaming,
    loading,
    settings,
    plugins,
    pluginsLoaded,
    modelCatalog,
    sessionModels,
    elapsed,
    selectSession,
    sendPrompt,
    createSession,
    loadWorkspace,
    updateSetting,
    openSettingsDocument,
    selectSessionModel,
    pendingInteractions,
  } = useDeepcLink()

  const [draft, setDraft] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchActive, setSearchActive] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("general")
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set())
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [viewSortOpen, setViewSortOpen] = useState(false)
  const [viewSort, setViewSort] = useState<ViewSort>(() => readViewSort())
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
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

  /** 切换工作区展开/收起。 */
  const toggleWorkspace = useCallback((workspaceId: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])

  // 消息流自动滚动到底部（依赖 messages：新消息/流式增量到来时滚到最新）。
  // oxlint-disable-next-line react/exhaustive-effect-dependencies
  useEffect(() => {
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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
  const preset = (settingValue("agent-presets")?.default as string) ?? "standard"
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

  // 分组渲染时隐藏 blank 会话（官方行为：Clients hide blank Sessions from lists），
  // 仅保留当前选中的「临时新建」行；并按 viewSort.orderBy 排序。
  const visibleSessions = useCallback((wsSessionIds: string[]) => {
    const list = wsSessionIds
      .map((id) => sessions.find((s) => s.sessionId === id))
      .filter((s): s is SessionSummary => Boolean(s))
      .filter((s) => !s.blank || s.sessionId === activeSessionId)
    if (viewSort.orderBy === "updated") {
      return list.toSorted((a, b) => b.updatedAt - a.updatedAt)
    }
    return list
  }, [sessions, activeSessionId, viewSort.orderBy])

  const handleSend = async () => {
    const text = draft.trim()
    if (!text) return
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
        {!sidebarCollapsed && (
          <aside className="flex w-70 shrink-0 flex-col border-r border-border/60 bg-sidebar">
            {/* 品牌行 + 收起 */}
            <div className="flex h-15 shrink-0 items-center justify-between px-3">
              <div className="flex min-w-0 items-center gap-2 px-1">
                <img
                  src="/deepseek.svg"
                  alt=""
                  aria-hidden
                  className="size-5 shrink-0 opacity-90 invert"
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
                className="w-full justify-start gap-2"
                onClick={() => void createSession(activeSession?.cwd ?? workspaces[0]?.path)}
              >
                <MessageSquarePlus className="size-4" />
                新建会话
              </Button>
            </div>

            {/* 工作区：标签 + 添加/刷新/排列 三按钮 */}
            <div className="mt-2 flex shrink-0 items-center gap-1 px-3">
              <span className="text-sm text-muted-foreground">工作区</span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  onClick={() => setFolderPickerOpen(true)}
                  title="添加工作区"
                >
                  <Plus className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  onClick={() => void loadWorkspace()}
                  title="刷新"
                >
                  <RefreshCw className="size-4" />
                </Button>
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-7 text-muted-foreground", viewSortOpen && "bg-muted/60")}
                    onClick={() => setViewSortOpen((v) => !v)}
                    title="排列"
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
                {/* 显隐性切换：搜索按钮 → 整行过滤框 */}
                {!searchActive && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    onClick={() => setSearchActive(true)}
                    title="搜索会话"
                  >
                    <Search className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            {/* 搜索：点击图标后整行变过滤框 */}
            {searchActive ? (
              <div className="shrink-0 px-3 pb-1">
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
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
              </div>
            ) : null}

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
                    />
                  )
                })()
              ) : (
                filteredWorkspaces.map((ws) => {
                  const wsSessions = visibleSessions(ws.sessionIds)
                  return (
                    <div key={ws.workspaceId} className="mb-1">
                      <button
                        type="button"
                        onClick={() => toggleWorkspace(ws.workspaceId)}
                        className="flex h-8.5 w-full items-center gap-1.5 rounded-lg px-2 text-sidebar-foreground transition-colors hover:bg-muted/60"
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5 shrink-0 text-muted-foreground transition-transform",
                            !collapsedWorkspaces.has(ws.workspaceId) && "rotate-90"
                          )}
                        />
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-left text-sm">
                          {ws.title || ws.path}
                        </span>
                      </button>
                      {!collapsedWorkspaces.has(ws.workspaceId) &&
                        wsSessions.map((s) => (
                          <SessionRow
                            key={s.sessionId}
                            session={s}
                            active={activeSessionId === s.sessionId}
                            onSelect={selectSession}
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
              {currentModelEntry && (
                <span className="hidden text-xs text-muted-foreground lg:inline">
                  {currentModelEntry.name}
                </span>
              )}
            </div>
          </div>

          {/* 消息流（滚动体） */}
          <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
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
                <ChatMessageList nodes={messages} />
                {isStreaming && (
                  <div className="flex items-center gap-2 py-2 pl-9 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在生成…
                  </div>
                )}
              </div>
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
              <div
                ref={editorRef}
                contentEditable={!!activeSessionId}
                suppressContentEditableWarning
                data-placeholder={activeSessionId ? "发送消息…" : "请先选择会话"}
                data-empty={!draft}
                className="min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-sm leading-6 text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)] [&_mark]:rounded [&_mark]:bg-primary/15 [&_mark]:px-0.5 [&_mark]:text-foreground"
                onInput={(e) => setDraft((e.target as HTMLDivElement).textContent ?? "")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
              />
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
            {/* 底部统计 */}
            <div className="mx-auto max-w-3xl px-4 pb-1.5">
              <div className="flex justify-center text-xs text-muted-foreground/70">
                {sessionStats.turns} 轮 · {sessionStats.steps} 步
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
                      onClick={() => void openSettingsDocument()}
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
                  <SettingsRow
                    title="Agent 预设"
                    desc="对此后新建的会话生效。运行中的会话保持它开始时的预设。"
                    value={preset}
                  />
                )}
              </div>
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
}: {
  sessions: SessionSummary[]
  activeSessionId: string | null | undefined
  onSelect: (id: string) => void
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
        />
      ))}
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
}: {
  session: SessionSummary
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => void onSelect(session.sessionId)}
      className={cn(
        "flex h-8 w-full items-center gap-1.5 rounded-lg px-2 pl-7 text-left text-sm transition-colors",
        active ? "bg-white/8 text-foreground" : "text-foreground/80 hover:bg-muted/60"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(session.updatedAt)}</span>
    </button>
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
