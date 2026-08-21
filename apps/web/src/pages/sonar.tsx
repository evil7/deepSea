// ---------------------------------------------------------------------------
// /sonar —— 操作互联（deepc-bridge 远程控制 · 自实现 chatUI）
//
// 复刻官方前端结构：
//   左 sidebar —— 工作区 + 会话列表（workspace.list + session.list）
//   右聊天区 —— 消息流（session.history 折叠）+ 思考/审计板块 + 输入框
// 数据经 deepc-bridge 加密 RTC 通道（WebRTC DataChannel）访问本地 dsh host。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Laptop,
  Link2,
  Loader2,
  MessageSquarePlus,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  SendHorizonal,
  Settings,
  Trash2,
  Unplug,
  Waves,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PageHeader } from "@/components/layout/page-header"
import { Textarea } from "@/components/ui/textarea"
import { ChatMessageList } from "@/components/sonar/chat-message"
import { useDeepcBridge } from "@/hooks/use-deepc-bridge"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { deepcClient, type ClientState } from "@/lib/deepc-bridge/client"
import type { SessionSummary } from "@/lib/deepc-bridge/protocol"
import { listNodes, getOrCreateConsoleNodeId, registerConsoleNode, removeNode, type NodeView } from "@/lib/deepc-bridge/nodes"

const STATE_META: Record<ClientState, { label: string; tone: string }> = {
  idle: { label: "未连接", tone: "bg-slate-500/20 text-slate-300" },
  connecting: { label: "连接中…", tone: "bg-sky-500/20 text-sky-300" },
  connected: { label: "已连接", tone: "bg-emerald-500/20 text-emerald-300" },
  reconnecting: { label: "重连中…", tone: "bg-amber-500/20 text-amber-300" },
  error: { label: "连接失败", tone: "bg-rose-500/20 text-rose-300" },
  disconnected: { label: "已断开", tone: "bg-slate-500/20 text-slate-300" },
}

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

/** 设置面板导航项（对齐官方 section id：models/agent-presets/plugins/general）。 */
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

export function SonarPage() {
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
    connectToNode,
    disconnect,
    selectSession,
    sendPrompt,
    createSession,
    loadWorkspace,
    updateSetting,
    openSettingsDocument,
    selectSessionModel,
  } = useDeepcBridge()

  const { user } = useAuth()
  const [nodes, setNodes] = useState<NodeView[]>([])
  const [nodesLoaded, setNodesLoaded] = useState(false)
  const [consoleNodeId, setConsoleNodeId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 设置面板当前标签页：通用设置 / 模型 / 插件 / Agent 预设。
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("general")
  // composer 工具栏下拉：命令 / 访问模式 / 模型。
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // 已收起的工作区 id 集合（默认全部展开）。
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set())
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  /** 关闭 composer 工具栏全部下拉。 */
  const closeToolbarMenus = useCallback(() => {
    setCommandMenuOpen(false)
    setPermissionMenuOpen(false)
    setModelMenuOpen(false)
  }, [])

  // 点击工具栏外部时收起下拉（mousedown 判定，点击菜单项不受影响）。
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

  // 登录后注册主站控制端节点（多端直连发起方的 answer 收件箱）。
  useEffect(() => {
    if (!user) {
      setConsoleNodeId(null)
      return
    }
    let cancelled = false
    void registerConsoleNode().then((id) => {
      if (cancelled) return
      setConsoleNodeId(id)
      // 刷新后自动恢复上次连接（vite full reload / 手滑刷新无感重连）。
      deepcClient.resumeLastConnection()
    })
    return () => {
      cancelled = true
    }
  }, [user])

  // 登录态加载设备列表（SSH 风格面板）；过滤掉主站自身的控制端节点。
  const refreshNodes = useCallback(async () => {
    if (!user) {
      setNodes([])
      setNodesLoaded(true)
      return
    }
    const list = await listNodes()
    const selfId = getOrCreateConsoleNodeId()
    setNodes(list.filter((n) => n.nodeId !== selfId))
    setNodesLoaded(true)
  }, [user])

  useEffect(() => {
    void refreshNodes()
  }, [refreshNodes])

  // 消息流自动滚动到底部。
  useEffect(() => {
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const connected = state === "connected" || state === "reconnecting"

  // 活动会话（header 标题用）。
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
  // 默认模型（agent-default-model.model），回退到 hello 携带的当前模型。
  const defaultModel =
    (settingValue("agent-default-model")?.model as string) ?? model?.model ?? ""

  // 写入回调：成功返回 true；失败静默（本地值不变，由 revision 冲突下次再试）。
  const setPref = useCallback(
    (ns: string, patch: Record<string, unknown>) => {
      void updateSetting(ns, patch)
    },
    [updateSetting]
  )

  // 会话统计（turns/steps），来自 session.list 的 sessionStats projection。
  const sessionStats = useMemo(() => {
    const stats = activeSession?.projections?.values?.sessionStats as
      | { turns?: number; steps?: number }
      | undefined
    return { turns: stats?.turns ?? 0, steps: stats?.steps ?? 0 }
  }, [activeSession])

  // ── composer 工具栏：会话模型（session.models）派生 ───────────────────
  // 当前模型 + 可选模型（groups 扁平化）+ 当前模型可用的推理等级。
  const currentModel = sessionModels?.current ?? model ?? null
  const modelOptions = useMemo(() => {
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
  const currentModelEntry = useMemo(
    () => modelOptions.find((m) => m.id === currentModel?.model),
    [modelOptions, currentModel]
  )
  const reasoningEfforts = useMemo(
    () => currentModelEntry?.reasoning?.efforts ?? [],
    [currentModelEntry]
  )

  // 访问模式（composer 工具栏）当前值 + 显示 label。
  const accessModeLabel =
    ACCESS_MODES.find((m) => m.value === permission)?.label ?? permission

  // 按搜索词过滤工作区会话（复刻官方侧栏搜索）。
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

  const handleSend = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    await sendPrompt(text)
  }

  // ── 未连接态：SSH 风格设备管理面板 ───────────────────────────────────────
  if (!connected) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
        <PageHeader
          title="操作互联"
          description="连接本机 dsh，远程控制 · 多端设备管理"
          sticky={false}
          showTopButton={false}
        />

        {/* 设备卡片网格 */}
        <div className="mt-10">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">已登录设备</h2>
            <Button variant="ghost" size="sm" onClick={() => void refreshNodes()} className="gap-1.5 text-xs">
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
          </div>

          {!user ? (
            <Card className="border-dashed">
              <CardContent className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                登录 GitHub 账号后，可查看并连接同一账号下的所有设备
              </CardContent>
            </Card>
          ) : !nodesLoaded ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载设备…
            </div>
          ) : nodes.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Laptop className="size-8 opacity-40" />
                暂无已登录设备
                <p className="text-xs text-muted-foreground/70">
                  在本地 dsh 的 deepc 侧栏登录并注册设备后，会显示在这里
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {nodes.map((node) => (
                <NodeCard
                  key={node.nodeId}
                  node={node}
                  onConnect={() => {
                    // 多端直连：点卡片直接经信箱信令连接（无需 connectId）。
                    if (consoleNodeId) {
                      void connectToNode(node.nodeId, consoleNodeId)
                    }
                  }}
                  onRemove={() => {
                    void removeNode(node.nodeId).then(() => refreshNodes())
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    )
  }

  // ── 已连接态：三栏复刻（左会话树 + 中聊天 + 输入框）────────────────────
  return (
    <div
      className="flex flex-col"
      style={{ height: `calc(100dvh - ${TOPBAR_H}px)` }}
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── 左：侧栏（复刻官方 hHd-Xa）────────────────────────────── */}
        {!sidebarCollapsed && (
          <aside className="flex w-70 shrink-0 flex-col border-r border-border/60 bg-sidebar">
            {/* 品牌行 + 收起 */}
            <div className="flex h-15 shrink-0 items-center justify-between px-3">
              <div className="flex items-center gap-2 px-1">
                <Waves className="size-5 text-primary" />
                <span className="text-sm font-semibold text-sidebar-foreground">deepSea</span>
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
                onClick={() =>
                  void createSession(activeSession?.cwd ?? workspaces[0]?.path)
                }
              >
                <MessageSquarePlus className="size-4" />
                新建会话
              </Button>
            </div>

            {/* 工作区 + 搜索 */}
            <div className="mt-2 flex shrink-0 items-center gap-1 px-3">
              <span className="text-sm text-muted-foreground">工作区</span>
              <div className="ml-auto flex items-center gap-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
                  <Search className="size-4" />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  onClick={() => void loadWorkspace()}
                  title="刷新"
                >
                  <RefreshCw className="size-4" />
                </Button>
              </div>
            </div>
            {/* 搜索输入框（常驻，对齐官方搜索） */}
            <div className="shrink-0 px-3 pb-1">
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
                <Search className="size-3.5 text-muted-foreground" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索会话…"
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                />
              </div>
            </div>

            {/* 会话树 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filteredWorkspaces.length === 0 && !keyword ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  暂无会话
                </p>
              ) : filteredWorkspaces.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  无匹配会话
                </p>
              ) : (
                filteredWorkspaces.map((ws) => {
                  const wsSessions = ws.sessionIds
                    .map((id) => sessions.find((s) => s.sessionId === id))
                    .filter((s): s is SessionSummary => Boolean(s))
                  return (
                    <div key={ws.workspaceId} className="mb-1">
                      {/* 项目行（可展开/收起） */}
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
                      {/* 会话行（收起时隐藏） */}
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

            {/* 底部设置 */}
            <div className="shrink-0 border-t border-border/60 p-2">
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-sm text-muted-foreground"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings className="size-4" />
                设置
              </Button>
            </div>
          </aside>
        )}

        {/* ── 中：聊天区 ───────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col bg-background">
          {/* header：会话标题 + 状态 + 断开 */}
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
                {activeSession ? sessionLabel(activeSession) : "操作互联"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {hostInfo?.model && (
                <span className="hidden text-xs text-muted-foreground lg:inline">
                  {hostInfo.model}
                </span>
              )}
              <Badge variant="outline" className={cn("border-transparent", STATE_META[state].tone)}>
                {STATE_META[state].label}
              </Badge>
              <Button
                onClick={disconnect}
                variant="outline"
                size="sm"
                className="gap-1.5 border-amber-400/40 bg-amber-400/10 text-amber-300 hover:border-amber-400/60 hover:bg-amber-400/20 hover:text-amber-200 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300 dark:hover:border-amber-400/60 dark:hover:bg-amber-400/20 dark:hover:text-amber-200"
              >
                <Unplug className="size-3.5" />
                断开
              </Button>
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
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                选择左侧会话，或发送第一条消息开始
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

          {/* 输入框（composer）：两行——输入区 + 工具栏 + 底部统计 */}
          <div className="shrink-0 border-t border-border/60 px-3 pb-2 pt-3">
            <div className="mx-auto max-w-3xl">
              {/* 输入卡片 */}
              <div className="rounded-xl border border-border/60 bg-background/40 focus-within:border-border">
                {/* 第一行：输入区 */}
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={activeSessionId ? "发送消息…" : "请先选择会话"}
                  disabled={!activeSessionId}
                  rows={2}
                  className="min-h-0 resize-none border-0 bg-transparent focus-visible:ring-0"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      void handleSend()
                    }
                  }}
                />
                {/* 第二行：工具栏 */}
                <div ref={toolbarRef} className="flex items-center justify-between gap-2 px-2 pb-2">
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
                                setCommandMenuOpen(false)
                                if (c.id === "model") setModelMenuOpen(true)
                                else if (c.id === "permission") setPermissionMenuOpen(true)
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
                                m.value === permission
                                  ? "text-foreground"
                                  : "text-muted-foreground"
                              )}
                              onClick={() => {
                                setPermissionMenuOpen(false)
                                setPref("permission", { defaultPreset: m.value })
                              }}
                            >
                              {m.label}
                              {m.value === permission && (
                                <span className="text-emerald-400">✓</span>
                              )}
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
                        title={`选择模型，当前 ${
                          currentModelEntry?.name ?? currentModel?.model ?? "选择模型"
                        }，推理等级 ${currentModel?.reasoningEffort ?? "-"}`}
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
                                m.id === currentModel?.model
                                  ? "text-foreground"
                                  : "text-muted-foreground"
                              )}
                              onClick={() => {
                                if (activeSessionId) {
                                  void selectSessionModel(
                                    activeSessionId,
                                    m.provider,
                                    m.id,
                                    currentModel?.reasoningEffort
                                  )
                                }
                              }}
                            >
                              {m.name}
                              {m.id === currentModel?.model && (
                                <span className="text-emerald-400">✓</span>
                              )}
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
                                    e.id === currentModel?.reasoningEffort
                                      ? "text-foreground"
                                      : "text-muted-foreground"
                                  )}
                                  onClick={() => {
                                    if (activeSessionId && currentModel) {
                                      void selectSessionModel(
                                        activeSessionId,
                                        currentModel.provider,
                                        currentModel.model,
                                        e.id
                                      )
                                    }
                                  }}
                                >
                                  {e.name}
                                  {e.id === currentModel?.reasoningEffort && (
                                    <span className="text-emerald-400">✓</span>
                                  )}
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
              {/* 底部统计：X 轮 · Y 步 */}
              <div className="flex justify-center py-1.5 text-xs text-muted-foreground/70">
                {sessionStats.turns} 轮 · {sessionStats.steps} 步
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 设置面板（复刻官方 dialog：导航 + 分页内容） */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSettingsOpen(false)}
          />
          <div className="relative flex h-150 w-180 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
            {/* 左侧导航 */}
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
            {/* 右侧主体 */}
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
                          desc={`id: ${m.id}${
                            m.contextWindow ? ` · 上下文 ${m.contextWindow.toLocaleString()}` : ""
                          }`}
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
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        无插件
                      </div>
                    ) : (
                      [...plugins]
                        .sort((a, b) => Number(b.enabled) - Number(a.enabled))
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
                                p.enabled
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-slate-500/15 text-slate-400"
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
  /** 单选样式（用于模型列表）：当前项高亮，点击整行选中。 */
  selected?: boolean
  onSelectValue?: () => void
}) {
  // 单选整行模式（模型列表等）。
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
        {selected && (
          <span className="shrink-0 text-xs text-emerald-400">当前</span>
        )}
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
                opt.value === value
                  ? "bg-muted/70 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40"
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

/** 会话行（复刻官方 YDXeBa_sessionRow：标题 + 相对时间 + 选中态）。 */
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
        active
          ? "bg-white/8 text-foreground"
          : "text-foreground/80 hover:bg-muted/60"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime(session.updatedAt)}
      </span>
    </button>
  )
}

/** 设备卡片（SSH 多端管理风格）。 */
function NodeCard({
  node,
  onConnect,
  onRemove,
}: {
  node: NodeView
  onConnect: () => void
  onRemove: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <Laptop className="size-5 shrink-0 text-primary" />
            <CardTitle className="truncate text-base">{node.name}</CardTitle>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 border-transparent",
              node.online
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-slate-500/20 text-slate-400"
            )}
          >
            {node.online ? "在线" : "离线"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="truncate font-mono text-xs text-muted-foreground">
          {node.nodeId}
        </p>
        <div className="flex gap-2">
          <Button
            onClick={onConnect}
            disabled={!node.online}
            variant="outline"
            size="sm"
            className="flex-1 gap-2"
          >
            <Link2 className="size-3.5" />
            连接
          </Button>
          <Button
            onClick={() => {
              if (confirmRemove) {
                setConfirmRemove(false)
                onRemove()
              } else {
                setConfirmRemove(true)
                setTimeout(() => setConfirmRemove(false), 3000)
              }
            }}
            variant="outline"
            size="sm"
            className={cn(
              "shrink-0 gap-1.5",
              confirmRemove
                ? "border-rose-500/50 bg-rose-500/10 text-rose-300 hover:border-rose-500/60 hover:bg-rose-500/20 hover:text-rose-200"
                : "text-muted-foreground"
            )}
          >
            <Trash2 className="size-3.5" />
            {confirmRemove ? "确认删除？" : "删除"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** 会话标题：空白会话显示「新会话」，否则取 cwd 目录名（无 title 字段的兜底）。 */
function sessionTitle(s: SessionSummary): string {
  if (s.blank) return "新会话"
  return s.cwd ? s.cwd.split(/[\\/]/).pop() || "会话" : "会话"
}

/** 会话行 label（header 展示用）：目录名 + 相对时间。 */
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

export default SonarPage
