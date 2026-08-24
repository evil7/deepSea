// ---------------------------------------------------------------------------
// useDeepcLink —— chatUI 状态管理 hook。
//
// 管理：连接状态 / 基础信息（host/theme/model）/ 工作区 / 会话列表 /
// 当前会话消息流 / 下行事件实时追加 / 发送消息。
// 数据经 deepcClient（RTC DataChannel）与本地 dsh host 交互。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { deepcClient, type ClientState } from "@/lib/deepc-link/client"
import {
  applyStreamChunk,
  classifyBlocks,
  foldEvents,
  isUserMessage,
  type RenderNode,
} from "@/lib/deepc-link/fold"
import type {
  AssistantBlock,
  AssistantChunkData,
  CommandItem,
  ContentBlock,
  ContextSource,
  DownstreamFrame,
  ApprovalRequestedFrame,
  QuestionRequestedFrame,
  HelloFrame,
  HistoryEntry,
  HostRemoteEventFrame,
  AgentPresetListResult,
  AgentPresetReadResult,
  ModelCatalogEntry,
  ModelSelection,
  PendingInteraction,
  PluginInventoryEntry,
  SessionEventFrame,
  SessionModelsView,
  SessionSummary,
  SettingsDescribeView,
  SettingsDocumentView,
  SettingsNamespaceView,
  TurnError,
  WorkspaceView,
} from "@/lib/deepc-link/protocol"

/** 正在流式输出的 assistant step（step/start 开启，assistant/chunk 累积，assistant/message 固化）。 */
interface StreamingStep {
  turn: number
  step: number
  seq: number
  time: number
  blocks: AssistantBlock[]
  error?: TurnError
}

export function useDeepcLink() {
  const [state, setState] = useState<ClientState>(deepcClient.state)
  const [connectedAt, setConnectedAt] = useState<number | null>(deepcClient.connectedAt)
  const [elapsed, setElapsed] = useState(0)
  const [hostInfo, setHostInfo] = useState<HelloFrame["host"] | null>(null)
  const [model, setModel] = useState<ModelSelection | null>(null)
  const [theme, setTheme] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [archivedSessionIds, setArchivedSessionIds] = useState<Set<string>>(new Set())
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<RenderNode[]>([])
  const [streaming, setStreaming] = useState<StreamingStep | null>(null)
  const [loading, setLoading] = useState(false)
  const [settings, setSettings] = useState<SettingsDescribeView | null>(null)
  const [plugins, setPlugins] = useState<PluginInventoryEntry[]>([])
  const [pluginsLoaded, setPluginsLoaded] = useState(false)
  const [agentPresets, setAgentPresets] = useState<AgentPresetListResult | null>(null)
  const [sessionModels, setSessionModels] = useState<SessionModelsView | null>(null)
  const [pendingInteractions, setPendingInteractions] = useState<PendingInteraction[]>([])

  const sessionIdsRef = useRef<Map<string, string>>(new Map())
  const callNamesRef = useRef<Map<string, string>>(new Map())
  const seqRef = useRef(0)
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeSessionId

  // 连接状态 / 基础信息事件订阅。
  useEffect(() => {
    const offState = deepcClient.on("state", (s) => {
      setState(s)
      setConnectedAt(deepcClient.connectedAt)
    })
    const offHello = deepcClient.on("hello", (hello) => {
      setHostInfo(hello.host)
      setModel(hello.model ?? null)
      setTheme(hello.theme)
      void loadWorkspace()
      void loadSettings()
      void loadPlugins()
    })
    const offError = deepcClient.on("error", (msg) => setError(msg))
    const offDownstream = deepcClient.on("downstream", (frame) => {
      handleDownstream(frame)
    })
    return () => {
      offState()
      offHello()
      offError()
      offDownstream()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 连接建立后订阅 events.mux（多路复用：该账号所有会话的下行事件经此流推送）。
  // host 端 api-bridge 只在收到 subscribe 帧后才开始推 downstream，故必须显式订阅。
  // 同时订阅 events.host（host 级 remote 事件，如 settings/document-updated）。
  useEffect(() => {
    if (state !== "connected") return
    const unsubMux = deepcClient.subscribe("mux", () => {})
    const unsubHost = deepcClient.subscribe("host", () => {})
    return () => {
      unsubMux()
      unsubHost()
    }
  }, [state])

  /** 读取 settings.describe 全量设置（真实动态值 + 插件注入 namespace）。 */
  const loadSettings = useCallback(async () => {
    const res = await deepcClient.call("settings.describe", {})
    if (res.ok && res.value) {
      setSettings(res.value as SettingsDescribeView)
    }
  }, [])

  /**
   * 读取插件清单（pluginInventory/list，typert Remote）。
   * 注意 payload 为 { args: {} }（remote 信封），method 用斜杠名。
   */
  const loadPlugins = useCallback(async () => {
    const res = await deepcClient.call("pluginInventory/list", { args: {} })
    if (res.ok && res.value) {
      const snap = res.value as { entries?: PluginInventoryEntry[] }
      setPlugins(snap.entries ?? [])
    }
    setPluginsLoaded(true)
  }, [])

  /**
   * 从 llm-deepseek namespace 提取可选模型目录（id → 显示名）。
   * 由 settings 派生，无需额外 RPC。
   */
  const modelCatalog = useMemo<ModelCatalogEntry[]>(() => {
    const view = settings?.namespaces.find((n) => n.ns === "llm-deepseek")
    const v = view?.value as { models?: ModelCatalogEntry[] } | undefined
    return v?.models ?? []
  }, [settings])

  /** 读取 settings 配置文件原文（deepc.settings.readDocument），供设置页只读整页展示。 */
  const readSettingsDocument = useCallback(async (): Promise<SettingsDocumentView | null> => {
    const res = await deepcClient.call("deepc.settings.readDocument", {})
    if (res.ok && res.value) return res.value as SettingsDocumentView
    return null
  }, [])

  /** 读取 agent 预设 roster（agentPreset.list）。 */
  const loadAgentPresets = useCallback(async () => {
    const res = await deepcClient.call("agentPreset.list", {})
    if (res.ok && res.value) {
      setAgentPresets(res.value as AgentPresetListResult)
    } else {
      // 失败也落到空 roster，避免设置页「预设」无限加载。
      setAgentPresets({ presets: [], authorable: false, hasDocument: false })
    }
  }, [])

  /** 只读查看某个预设的 composition 原文（agentPreset.read）。 */
  const readAgentPreset = useCallback(
    async (id: string): Promise<AgentPresetReadResult | null> => {
      const res = await deepcClient.call("agentPreset.read", { agentPreset: id })
      if (res.ok && res.value) return res.value as AgentPresetReadResult
      return null
    },
    []
  )

  /** 复制一个预设为新的本地预设（agentPreset.copy）。 */
  const copyAgentPreset = useCallback(
    async (from: string, id: string, name?: string): Promise<boolean> => {
      const res = await deepcClient.call("agentPreset.copy", { from, agentPreset: id, name })
      if (res.ok) await loadAgentPresets()
      return res.ok
    },
    [loadAgentPresets]
  )

  /** 删除一个本地预设（agentPreset.remove）。 */
  const removeAgentPreset = useCallback(
    async (id: string): Promise<boolean> => {
      const res = await deepcClient.call("agentPreset.remove", { agentPreset: id })
      if (res.ok) await loadAgentPresets()
      return res.ok
    },
    [loadAgentPresets]
  )

  /**
   * 写入一个 namespace 的顶层字段 patch（settings.update，带 expectedRevision）。
   * 成功后用返回的 namespace view 折叠回本地 settings，无需重读。
   */
  const updateSetting = useCallback(
    async (ns: string, patch: Record<string, unknown>): Promise<boolean> => {
      const current = settings?.namespaces.find((n) => n.ns === ns)
      const res = await deepcClient.call("settings.update", {
        ns,
        patch,
        expectedRevision: current?.revision,
      })
      if (res.ok && res.value) {
        const view = res.value as SettingsNamespaceView
        setSettings((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            namespaces: prev.namespaces.map((n) => (n.ns === ns ? view : n)),
          }
        })
        return true
      }
      return false
    },
    [settings]
  )

  /** 设为默认预设（写 settings agent-presets.default；新建会话生效）。 */
  const setDefaultAgentPreset = useCallback(
    async (id: string): Promise<boolean> => updateSetting("agent-presets", { default: id }),
    [updateSetting]
  )

  /** 加载工作区 + 会话列表。 */
  const loadWorkspace = useCallback(async () => {
    const wsRes = await deepcClient.call("workspace.list", {})
    let registered: WorkspaceView[] = []
    if (wsRes.ok && wsRes.value) {
      const value = wsRes.value as { items?: WorkspaceView[]; archivedSessionIds?: string[] }
      registered = value.items ?? []
      // 归档集合（registry-global）：官方 sessionVisible 会隐藏这些会话。
      setArchivedSessionIds(new Set(value.archivedSessionIds ?? []))
    }
    const sRes = await deepcClient.call("session.list", {})
    if (sRes.ok && sRes.value) {
      const value = sRes.value as { items?: SessionSummary[] }
      const items = value.items ?? []
      setSessions(items)
      // sessionId → 工作区（cwd）映射，供 sidebar 分组。
      const map = new Map<string, string>()
      for (const s of items) map.set(s.sessionId, s.cwd ?? "")
      sessionIdsRef.current = map

      // 未分组兜底：不在任何已注册 workspace sessionIds 里的会话，聚合成一个
      // 「未分组」工作组（对齐官方 groupByWorkspace 的 Ungrouped 语义——单一组，
      // 浏览器本地排序，不按 cwd 拆子组）。
      // dsh 工作区是显式注册实体（workspace.create / 首次启动 bootstrap），
      // workspace.list 可能返回空，而 session.list 仍有会话——此时不能显示「暂无会话」。
      const accounted = new Set<string>()
      for (const ws of registered) for (const id of ws.sessionIds) accounted.add(id)
      const stray = items.filter((s) => !accounted.has(s.sessionId))
      if (stray.length > 0) {
        registered = [
          ...registered,
          {
            workspaceId: "ungrouped",
            path: "",
            title: "未分组",
            sessionIds: stray.map((s) => s.sessionId),
            createdAt: "",
            updatedAt: "",
          },
        ]
      }
      setWorkspaces(registered)
    }
  }, [])

  /** 选中会话 → 加载历史消息 + 会话模型。 */
  const selectSession = useCallback(async (sessionId: string) => {
    setActiveSessionId(sessionId)
    setMessages([])
    setStreaming(null)
    setLoading(true)
    const res = await deepcClient.call("session.history", {
      sessionId,
      maxMessages: 50,
    })
    setLoading(false)
    if (res.ok && res.value) {
      const value = res.value as { events?: HistoryEntry[] }
      setMessages(foldEvents(value.events ?? []))
    }
    void loadSessionModels(sessionId)
  }, [])

  /** 读取当前会话的 dsh slash 命令（deepc.commands.list，对齐官方 / 命令联想）。 */
  const loadCommands = useCallback(
    async (sessionId: string): Promise<CommandItem[]> => {
      const res = await deepcClient.call("deepc.commands.list", { sessionId })
      if (res.ok && res.value) {
        const value = res.value as { items?: CommandItem[] }
        return value.items ?? []
      }
      return []
    },
    []
  )

  /** 读取当前会话模型（session.models）。 */
  const loadSessionModels = useCallback(async (sessionId: string) => {
    const res = await deepcClient.call("session.models", { sessionId })
    if (res.ok && res.value) {
      setSessionModels(res.value as SessionModelsView)
    } else {
      setSessionModels(null)
    }
  }, [])

  /** 切换当前会话模型（session.selectModel）。 */
  const selectSessionModel = useCallback(
    async (sessionId: string, provider: string, model: string, reasoningEffort?: string) => {
      const res = await deepcClient.call("session.selectModel", {
        sessionId,
        provider,
        model,
        reasoningEffort,
      })
      if (res.ok && res.value) {
        const v = res.value as { selected?: ModelSelection }
        setSessionModels((prev) =>
          prev && v.selected ? { ...prev, current: v.selected } : prev
        )
        return true
      }
      return false
    },
    []
  )

  /** 发送消息。 */
  const sendPrompt = useCallback(
    async (text: string) => {
      if (!activeRef.current) return false
      const res = await deepcClient.call("session.prompt", {
        sessionId: activeRef.current,
        mode: "queue",
        content: [{ type: "text", text }],
      })
      return res.ok
    },
    []
  )

  /** 新建会话（传入 cwd 关联工作区；成功后刷新会话列表并选中）。 */
  const createSession = useCallback(
    async (cwd?: string): Promise<boolean> => {
      const res = await deepcClient.call("session.create", cwd ? { cwd } : {})
      if (!res.ok) return false
      const value = (res.value ?? {}) as { sessionId?: string }
      const sessionId = value.sessionId
      await loadWorkspace()
      if (sessionId) {
        setActiveSessionId(sessionId)
        activeRef.current = sessionId
        setMessages([])
        setStreaming(null)
      }
      return true
    },
    [loadWorkspace]
  )

  /** 消息分支（对齐官方 session.fork RPC）：以该事件 seq 为前缀新建子会话。 */
  const forkSession = useCallback(
    async (atSeq: number): Promise<boolean> => {
      if (!activeRef.current) return false
      const res = await deepcClient.call("session.fork", {
        sessionId: activeRef.current,
        atSeq,
      })
      if (res.ok) {
        await loadWorkspace()
      }
      return res.ok
    },
    [loadWorkspace]
  )

  /**
   * 全量刷新：重新拉取远端 dsh 的所有数据，等价于刚连接时 hello 触发的全量加载。
   *   · 工作区 + 会话列表（workspace.list / session.list）
   *   · 设置（settings.describe）与插件清单（pluginInventory/list）
   *   · 当前选中会话的历史 + 模型（若已选中）
   * 供 sidebar「刷新」按钮调用，确保数据与远端 dsh 实时一致。
   */
  const refreshAll = useCallback(async () => {
    await loadWorkspace()
    await loadSettings()
    await loadPlugins()
    await loadAgentPresets()
    const active = activeRef.current
    if (active) {
      // 重新拉当前会话历史 + 模型（refresh 等同重新进入该会话）。
      setActiveSessionId(active)
      const res = await deepcClient.call("session.history", { sessionId: active, maxMessages: 50 })
      if (res.ok && res.value) {
        const value = res.value as { events?: HistoryEntry[] }
        setMessages(foldEvents(value.events ?? []))
      }
      await loadSessionModels(active)
    }
  }, [loadWorkspace, loadSettings, loadPlugins, loadAgentPresets, loadSessionModels])

  /** 工作区重命名（对齐官方 workspace.rename）。 */
  const renameWorkspace = useCallback(
    async (workspaceId: string, title: string): Promise<boolean> => {
      const res = await deepcClient.call("workspace.rename", { workspaceId, title })
      await loadWorkspace()
      return res.ok
    },
    [loadWorkspace]
  )

  /** 工作区删除（对齐官方 workspace.delete）。 */
  const deleteWorkspace = useCallback(
    async (workspaceId: string): Promise<boolean> => {
      const res = await deepcClient.call("workspace.delete", { workspaceId })
      await loadWorkspace()
      return res.ok
    },
    [loadWorkspace]
  )

  /** 会话重命名（对齐官方 session.rename，title 用 projection 写）。 */
  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<boolean> => {
      const res = await deepcClient.call("session.rename", { sessionId, title })
      await loadWorkspace()
      return res.ok
    },
    [loadWorkspace]
  )

  /** 会话归档（对齐官方 workspace.archiveSession）。 */
  const archiveSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const res = await deepcClient.call("workspace.archiveSession", { sessionId })
      await loadWorkspace()
      return res.ok
    },
    [loadWorkspace]
  )

  /**
   * 下行事件：mux 流推来的 session/event 实时消费（对齐官方客户端分层）。
   *   · step/start        → 开启流式 assistant 节点（「生成中」）
   *   · assistant/chunk   → applyStreamChunk 累积（打字机）
   *   · assistant/message → 完整替换固化（surface 权威态，supersede partial）
   *   · user/message / tool/result → 追加已固化节点
   */
  function handleDownstream(frame: DownstreamFrame) {
    const payload = frame.envelope.payload
    if (!payload || typeof payload !== "object") return
    const p = payload as { type?: string }
    const nextSeq = () => ++seqRef.current

    // host 级 remote 事件（events.host 流）——settings/document-updated 触发全量刷新。
    if (p.type === "host/remote-event") {
      const ev = payload as HostRemoteEventFrame
      if (ev.event === "settings/document-updated") {
        void loadSettings()
      }
      return
    }

    // 顶层提问/审批帧（MuxFrame 顶层，非 session/event 内）——composer 接管 + 侧栏 badge。
    if (p.type === "question/requested") {
      const f = payload as QuestionRequestedFrame
      if (f.sessionId === activeRef.current) {
        setMessages((prev) => [
          ...prev,
          { kind: "question", seq: nextSeq(), time: Date.now(), questions: f.questions ?? [] },
        ])
      }
      setPendingInteractions((prev) => {
        const rest = prev.filter((x) => x.kind !== "question")
        return [...rest, { kind: "question", id: f.questions?.[0]?.id ?? "q", questions: f.questions }]
      })
      return
    }
    if (p.type === "approval/requested") {
      const f = payload as ApprovalRequestedFrame
      if (f.sessionId === activeRef.current) {
        setMessages((prev) => [
          ...prev,
          {
            kind: "approval",
            seq: nextSeq(),
            time: Date.now(),
            approvalId: f.approvalId,
            toolName: f.toolName,
            callId: f.callId,
            reason: f.reason,
          },
        ])
      }
      setPendingInteractions((prev) => {
        const rest = prev.filter((x) => x.kind !== "approval")
        return [...rest, { kind: "approval", id: f.approvalId, toolName: f.toolName, reason: f.reason }]
      })
      return
    }
    if (p.type === "approval/resolved" || p.type === "question/answered") {
      const target = (payload as { approvalId?: string }).approvalId
      setPendingInteractions((prev) =>
        prev.filter((x) => (target ? x.id !== target : x.kind === "question" ? false : x.kind === "approval"))
      )
      return
    }

    if (p.type !== "session/event") return
    const evt = payload as SessionEventFrame
    if (evt.sessionId !== activeRef.current) return
    const event = evt.event

    switch (event.type) {
      case "step/start": {
        const d = event.data as { turn: number; step: number }
        setStreaming({
          turn: d.turn,
          step: d.step,
          seq: event.seq,
          time: event.time,
          blocks: [],
        })
        break
      }
      case "assistant/chunk": {
        const d = event.data as AssistantChunkData
        const chunk = d.chunk
        if (!chunk) break
        setStreaming((prev) => {
          const base: StreamingStep =
            prev && prev.turn === (d.turn ?? prev.turn) && prev.step === (d.step ?? prev.step)
              ? prev
              : {
                  turn: d.turn ?? 0,
                  step: d.step ?? 0,
                  seq: event.seq,
                  time: event.time,
                  blocks: [],
                }
          // finish 分块携带错误时记录，供「本轮运行失败」实时展示。
          let error = base.error
          if (chunk.type === "finish" && chunk.reason?.kind === "error" && chunk.reason.failure) {
            error = { message: chunk.reason.failure.message, code: chunk.reason.failure.code }
          }
          return { ...base, blocks: applyStreamChunk(base.blocks, chunk), error }
        })
        break
      }
      case "assistant/message": {
        const d = event.data as {
          turn?: number
          step?: number
          message?: { content?: ContentBlock[]; id?: string }
          usage?: unknown
        }
        const blocks = classifyBlocks(d.message?.content ?? [])
        for (const b of blocks) {
          if (b.kind === "tool-call") callNamesRef.current.set(b.callId, b.name)
        }
        setStreaming(null)
        if (blocks.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              kind: "assistant",
              seq: event.seq,
              time: event.time,
              turn: d.turn ?? 0,
              step: d.step ?? 0,
              messageId: d.message?.id,
              blocks,
              usage: d.usage,
            },
          ])
        }
        break
      }
      case "user/message": {
        const d = event.data as { content?: ContentBlock[]; source?: unknown }
        setStreaming(null)
        const content = d.content ?? []
        if (content.length > 0) {
          // 对齐官方：source.kind !== 'user'（plugin / goal / 其它注入）→ 上下文注入节点，
          // 与 fold.ts 的 foldEvents 判定一致，避免系统 prompt 渲染成用户气泡。
          if (!isUserMessage(d.source)) {
            setMessages((prev) => [
              ...prev,
              {
                kind: "context",
                seq: event.seq,
                time: event.time,
                content,
                source: (d.source ?? {}) as ContextSource,
              },
            ])
          } else {
            setMessages((prev) => [
              ...prev,
              { kind: "user", seq: event.seq, time: event.time, content, source: d.source },
            ])
          }
        }
        break
      }
      case "tool/result": {
        const d = event.data as {
          message?: { source?: { callId?: string }; content?: ContentBlock[] }
        }
        const toolResult = d.message?.content?.find((c) => c.type === "tool-result")
        if (!toolResult) break
        const callId = toolResult.toolCallId ?? d.message?.source?.callId ?? ""
        setMessages((prev) => [
          ...prev,
          {
            kind: "tool",
            seq: event.seq,
            time: event.time,
            callId,
            name: callNamesRef.current.get(callId) ?? null,
            content: toolResult.content ?? [],
            isError: toolResult.isError === true,
          },
        ])
        break
      }
      case "step/end": {
        // step 结束（正常或失败）。若尚无 assistant/message 固化，则关闭「生成中」指示器。
        const d = event.data as { turn?: number; step?: number }
        setStreaming((prev) => {
          if (!prev) return prev
          if (d.turn != null && d.turn !== prev.turn) return prev
          if (d.step != null && d.step !== prev.step) return prev
          return null
        })
        break
      }
      case "turn/end": {
        // turn 兜底边界：任何残留的流式指示器在此关闭；错误原因固化为 error 节点。
        const d = event.data as {
          turn?: number
          reason?: { kind?: string; error?: TurnError }
        }
        const err = d.reason?.kind === "error" ? d.reason.error : undefined
        const msg = err?.message
        if (msg) {
          const code = err.code
          setMessages((prev) => [
            ...prev,
            { kind: "error", seq: event.seq, time: event.time, message: msg, code },
          ])
        }
        setStreaming(null)
        break
      }
      default:
        // turn/start、assistant 之外的 chunk、approval/* 等忽略
        break
    }
  }

  // 连接后每秒刷新连接时长（供 sidebar「时长」展示）。离开 connected 即归零。
  useEffect(() => {
    if (state !== "connected" || connectedAt == null) {
      setElapsed(0)
      return
    }
    setElapsed(Math.floor((Date.now() - connectedAt) / 1000))
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - connectedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [state, connectedAt])

  const connectToNode = useCallback(
    async (targetNodeId: string, selfNodeId: string) => {
      setError(null)
      await deepcClient.connectToNode(targetNodeId, selfNodeId)
    },
    []
  )

  const disconnect = useCallback(() => {
    deepcClient.disconnect()
    setHostInfo(null)
    setWorkspaces([])
    setSessions([])
    setActiveSessionId(null)
    setMessages([])
    setStreaming(null)
  }, [])

  // 合并渲染节点：已固化消息 + 当前流式 assistant（打字机）+ 实时错误。
  const renderNodes = useMemo(() => {
    if (!streaming) return messages
    const extra: RenderNode[] = []
    if (streaming.blocks.length > 0) {
      extra.push({
        kind: "assistant",
        seq: streaming.seq,
        time: streaming.time,
        turn: streaming.turn,
        step: streaming.step,
        blocks: streaming.blocks,
      })
    }
    if (streaming.error?.message) {
      extra.push({
        kind: "error",
        seq: streaming.seq,
        time: streaming.time,
        message: streaming.error.message,
        code: streaming.error.code,
      })
    }
    return [...messages, ...extra]
  }, [messages, streaming])

  return {
    state,
    connectedAt,
    elapsed,
    hostInfo,
    model,
    theme,
    error,
    workspaces,
    sessions,
    archivedSessionIds,
    activeSessionId,
    messages: renderNodes,
    // 有流式且非错误时才显示「正在生成…」；错误态由 renderNodes 里的 error 节点展示。
    isStreaming: streaming !== null && streaming.error == null,
    loading,
    settings,
    plugins,
    pluginsLoaded,
    agentPresets,
    modelCatalog,
    sessionModels,
    pendingInteractions,
    connectToNode,
    disconnect,
    selectSession,
    sendPrompt,
    createSession,
    forkSession,
    renameWorkspace,
    deleteWorkspace,
    renameSession,
    archiveSession,
    loadWorkspace,
    loadSettings,
    loadPlugins,
    refreshAll,
    updateSetting,
    readSettingsDocument,
    loadAgentPresets,
    readAgentPreset,
    copyAgentPreset,
    removeAgentPreset,
    setDefaultAgentPreset,
    loadSessionModels,
    loadCommands,
    selectSessionModel,
  }
}
