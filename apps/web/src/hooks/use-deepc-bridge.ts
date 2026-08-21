// ---------------------------------------------------------------------------
// useDeepcBridge —— chatUI 状态管理 hook。
//
// 管理：连接状态 / 基础信息（host/theme/model）/ 工作区 / 会话列表 /
// 当前会话消息流 / 下行事件实时追加 / 发送消息。
// 数据经 deepcClient（RTC DataChannel）与本地 dsh host 交互。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"

import { deepcClient, type ClientState } from "@/lib/deepc-bridge/client"
import { foldEvents, type RenderNode } from "@/lib/deepc-bridge/fold"
import type {
  DownstreamFrame,
  HelloFrame,
  HistoryEntry,
  SessionEventFrame,
  SessionSummary,
  WorkspaceView,
} from "@/lib/deepc-bridge/protocol"

export function useDeepcBridge() {
  const [state, setState] = useState<ClientState>(deepcClient.state)
  const [hostInfo, setHostInfo] = useState<HelloFrame["host"] | null>(null)
  const [theme, setTheme] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<RenderNode[]>([])
  const [loading, setLoading] = useState(false)

  const sessionIdsRef = useRef<Map<string, string>>(new Map())
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeSessionId

  // 连接状态 / 基础信息事件订阅。
  useEffect(() => {
    const offState = deepcClient.on("state", (s) => setState(s))
    const offHello = deepcClient.on("hello", (hello) => {
      setHostInfo(hello.host)
      setTheme(hello.theme)
      void loadWorkspace()
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

  /** 加载工作区 + 会话列表。 */
  const loadWorkspace = useCallback(async () => {
    const wsRes = await deepcClient.call("workspace.list", {})
    if (wsRes.ok && wsRes.value) {
      const value = wsRes.value as { items?: WorkspaceView[] }
      setWorkspaces(value.items ?? [])
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
    }
  }, [])

  /** 选中会话 → 加载历史消息。 */
  const selectSession = useCallback(async (sessionId: string) => {
    setActiveSessionId(sessionId)
    setMessages([])
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
  }, [])

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

  /** 下行事件：session/event 实时追加到当前会话。 */
  function handleDownstream(frame: DownstreamFrame) {
    const payload = frame.envelope.payload
    if (!payload || typeof payload !== "object") return
    const p = payload as { type?: string }
    if (p.type === "session/event") {
      const evt = payload as SessionEventFrame
      if (evt.sessionId !== activeRef.current) return
      const historyEntry: HistoryEntry = { event: evt.event }
      setMessages((prev) => [...prev, ...foldEvents([historyEntry])])
    }
  }

  const connect = useCallback(
    async (pairCode: string) => {
      setError(null)
      await deepcClient.connect(pairCode)
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
  }, [])

  return {
    state,
    hostInfo,
    theme,
    error,
    workspaces,
    sessions,
    activeSessionId,
    messages,
    loading,
    connect,
    disconnect,
    selectSession,
    sendPrompt,
    loadWorkspace,
  }
}
