// ---------------------------------------------------------------------------
// ChatShell —— 已连接态的 chatUI 外壳（复刻官方 三栏布局）。
//
// 左 sidebar：品牌 + 新建会话 + 工作区搜索 + 会话树 + 底部【设置 + 连接状态】
// 中聊天区：header（会话标题 + 刷新）+ 消息流（含 hero 空态）+ 输入框（composer）
//
// 由 /link/:nodeId 路由渲染；数据来自 useDeepcLink（RTC DataChannel）。
// 子模块已拆分：sidebar.tsx / composer.tsx / hero-shell.tsx / settings-panel.tsx。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Loader2, PanelLeft, RefreshCw, Waves } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ChatMessageList } from "@/components/link/chat-message"
import { Composer, type ComposerModelOption } from "@/components/link/composer"
import { HeroShell } from "@/components/link/hero-shell"
import { SettingsPanel, type SettingsTabId } from "@/components/link/settings-panel"
import { Sidebar, sessionLabel } from "@/components/link/sidebar"
import { FolderPicker } from "@/components/link/folder-picker"
import { useDeepcLink } from "@/hooks/use-deepc-link"
import type { SessionSummary } from "@/lib/deepc-link/protocol"

const TOPBAR_H = 64

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
): ComposerModelOption[] {
  return useMemo(() => {
    const list: ComposerModelOption[] = []
    for (const g of sessionModels?.groups ?? []) {
      for (const m of g.models) {
        list.push({ provider: g.id, id: m.id, name: m.name, reasoning: m.reasoning })
      }
    }
    return list
  }, [sessionModels])
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
    startSessionAndSend,
    forkSession,
    forkSessionById,
    renameWorkspace,
    deleteWorkspace,
    renameSession,
    archiveSession,
    refreshAll,
    updateSetting,
    readSettingsDocument,
    loadAgentPresets,
    readAgentPreset,
    copyAgentPreset,
    removeAgentPreset,
    setDefaultAgentPreset,
    loadCommands,
    selectSessionModel,
    pendingInteractions,
  } = useDeepcLink()

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("general")
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  // hero 空态参数（新建会话：工作区 cwd + agent 预设）。用户未显式选择时回退到默认。
  const [heroCwd, setHeroCwd] = useState<string | undefined>(undefined)
  const [heroAgentPreset, setHeroAgentPreset] = useState<string | undefined>(undefined)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)

  // 消息流滚动：仅在「当前位于底部」时才自动跟随（对齐官方 atBottomRef）。
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

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isStreaming])

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
  const defaultModel = (settingValue("agent-default-model")?.model as string) ?? model?.model ?? ""
  const defaultModelProvider =
    (settingValue("agent-default-model")?.provider as string) ?? "deepseek-official"

  // 写入回调：成功返回 true；失败静默。
  const setPref = useCallback(
    (ns: string, patch: Record<string, unknown>) => {
      void updateSetting(ns, patch)
    },
    [updateSetting]
  )

  // 会话统计（turns/steps）。
  const sessionStats = useMemoStats(activeSession)

  // ── composer 工具栏：会话模型（session.models）派生 ───────────────────
  const currentModel = sessionModels?.current ?? model ?? null
  const modelOptions = useMemoModelOptions(sessionModels)
  const currentModelEntry = useMemo(
    () => modelOptions.find((m) => m.id === currentModel?.model),
    [modelOptions, currentModel]
  )
  const reasoningEfforts = useMemo(
    () => currentModelEntry?.reasoning?.efforts ?? [],
    [currentModelEntry]
  )

  // 访问模式当前值 + 显示 label。
  const ACCESS_MODES = [
    { value: "read-only", label: "Read Only" },
    { value: "workspace-write", label: "Workspace Write" },
    { value: "danger-full-access", label: "Full access" },
  ]
  const accessModeLabel = ACCESS_MODES.find((m) => m.value === permission)?.label ?? permission

  // ── hero 空态参数派生（用户未显式选择时回退到 blank 会话 cwd / host cwd / 默认预设）────
  const effectiveHeroCwd =
    heroCwd ?? activeSession?.cwd ?? hostInfo?.cwd ?? workspaces[0]?.path
  const heroPresetOptions = useMemo(
    () => agentPresets?.presets.filter((p) => !p.broken) ?? [],
    [agentPresets]
  )
  const defaultPresetId = useMemo(
    () =>
      agentPresets?.presets.find((p) => p.isDefault)?.id ??
      agentPresets?.presets.find((p) => !p.broken)?.id,
    [agentPresets]
  )
  const effectiveHeroPreset = heroAgentPreset ?? defaultPresetId
  const heroPresetName = useMemo(
    () => heroPresetOptions.find((p) => p.id === effectiveHeroPreset)?.name ?? effectiveHeroPreset,
    [heroPresetOptions, effectiveHeroPreset]
  )
  const heroCwdLabel = useMemo(() => {
    if (!effectiveHeroCwd) return "选择工作区"
    const seg = effectiveHeroCwd.split(/[\\/]/).at(-1)
    return seg || effectiveHeroCwd
  }, [effectiveHeroCwd])

  // 发送文本（已有会话[含 blank] → 发消息；无会话 → 建会话 + 发首条消息）。
  const handleSendText = useCallback(
    (text: string) => {
      if (activeSessionId) {
        void sendPrompt(text)
      } else {
        void startSessionAndSend(effectiveHeroCwd, effectiveHeroPreset, text)
      }
    },
    [activeSessionId, sendPrompt, startSessionAndSend, effectiveHeroCwd, effectiveHeroPreset]
  )

  const handleSelectModel = useCallback(
    (provider: string, mdl: string, effort?: string) => {
      if (activeSessionId) void selectSessionModel(activeSessionId, provider, mdl, effort)
    },
    [activeSessionId, selectSessionModel]
  )

  const handleSetPermission = useCallback(
    (preset: string) => {
      void setPref("permission", { defaultPreset: preset })
    },
    [setPref]
  )

  const composerProps = {
    activeSessionId,
    permission,
    accessModeLabel,
    currentModel,
    modelOptions,
    currentModelEntry,
    reasoningEfforts,
    sessionStats,
    pendingInteractions,
    onSend: handleSendText,
    onSelectModel: handleSelectModel,
    onSetPermission: handleSetPermission,
    loadCommands,
  }

  const heroComposer = <Composer variant="hero" {...composerProps} />
  const bottomComposer = <Composer variant="bottom" {...composerProps} />

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <div
        className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background"
        style={{ height: `calc(100dvh - ${TOPBAR_H}px - 3rem)` }}
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed(true)}
            hostInfo={hostInfo}
            workspaces={workspaces}
            sessions={sessions}
            archivedSessionIds={archivedSessionIds}
            activeSessionId={activeSessionId}
            state={state}
            elapsed={elapsed}
            onSelectSession={selectSession}
            onCreateSession={(cwd) => void createSession(cwd)}
            onAddWorkspace={() => setFolderPickerOpen(true)}
            onRenameWorkspace={(id, title) => void renameWorkspace(id, title)}
            onDeleteWorkspace={(id) => void deleteWorkspace(id)}
            onRenameSession={(id, title) => void renameSession(id, title)}
            onForkSession={(id) => void forkSessionById(id)}
            onArchiveSession={(id) => void archiveSession(id)}
            onOpenSettings={() => setSettingsOpen(true)}
            onDisconnect={onDisconnect}
          />

          {/* ── 中：聊天区 ───────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col bg-background">
            {/* header：会话标题 + 刷新 */}
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
                ) : !activeSessionId || activeSession?.blank ? (
                  // hero 空态：无选中会话 或 新建的 blank 会话（未跑 turn）——中央 headline + 参数 chip + 输入卡
                  <HeroShell
                    workspaces={workspaces.filter((ws) => ws.workspaceId !== "ungrouped")}
                    presetOptions={heroPresetOptions}
                    effectiveCwd={effectiveHeroCwd}
                    cwdLabel={heroCwdLabel}
                    effectivePreset={effectiveHeroPreset}
                    presetName={heroPresetName}
                    onSelectCwd={setHeroCwd}
                    onSelectPreset={setHeroAgentPreset}
                    onBrowseFolder={() => setFolderPickerOpen(true)}
                    composer={heroComposer}
                  />
                ) : messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                    <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                      <Waves className="size-6 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">开始一段对话</p>
                      <p className="text-xs text-muted-foreground">发送第一条消息开始</p>
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
              {/* 回到底部浮层按钮 */}
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

            {/* 底部 composer：仅已选非 blank 会话时显示（hero 空态 / blank 会话用中央 composer） */}
            {activeSessionId && !activeSession?.blank && bottomComposer}
          </div>
        </div>
      </div>

      {/* 虚拟文件夹选择窗口 */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={(path) => {
          setFolderPickerOpen(false)
          if (activeSessionId) {
            void createSession(path)
          } else {
            setHeroCwd(path)
          }
        }}
        homePath={hostInfo?.home}
      />

      {/* 设置面板（复刻官方 dialog） */}
      <SettingsPanel
        open={settingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={() => setSettingsOpen(false)}
        permission={permission}
        locale={locale}
        theme={theme}
        busyEnter={busyEnter}
        modelCatalog={modelCatalog}
        defaultModel={defaultModel}
        defaultModelProvider={defaultModelProvider}
        plugins={plugins}
        pluginsLoaded={pluginsLoaded}
        agentPresets={agentPresets}
        setPref={setPref}
        readSettingsDocument={readSettingsDocument}
        loadAgentPresets={loadAgentPresets}
        readAgentPreset={readAgentPreset}
        copyAgentPreset={copyAgentPreset}
        removeAgentPreset={removeAgentPreset}
        setDefaultAgentPreset={setDefaultAgentPreset}
      />
    </main>
  )
}
