// ---------------------------------------------------------------------------
// useDeepcBridge —— chatUI 状态管理 hook。
//
// 管理：连接状态 / 基础信息（host/theme/model）/ 工作区 / 会话列表 /
// 当前会话消息流 / 下行事件实时追加 / 发送消息。
// 数据经 deepcClient（RTC DataChannel）与本地 dsh host 交互。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { deepcClient, type ClientState } from "@/lib/deepc-bridge/client"
import {
  applyStreamChunk,
  classifyBlocks,
  foldEvents,
  type RenderNode,
} from "@/lib/deepc-bridge/fold"
import type {
  AssistantBlock,
  AssistantChunkData,
  ContentBlock,
  DownstreamFrame,
  HelloFrame,
  HistoryEntry,
  SessionEventFrame,
  SessionSummary,
  WorkspaceView,
} from "@/lib/deepc-bridge/protocol"

/** 正在流式输出的 assistant step（step/start 开启，assistant/chunk 累积，assistant/message 固化）。 */
interface StreamingStep {
  turn: number
  step: number
  seq: number
  time: number
  blocks: AssistantBlock[]
}

export function useDeepcBridge() {
  const [state, setState] = useState<ClientState>(deepcClient.state)
  const [hostInfo, setHostInfo] = useState<HelloFrame["host"] | null>(null)
  const [theme, setTheme] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<RenderNode[]>([])
  const [streaming, setStreaming] = useState<StreamingStep | null>(null)
  const [loading, setLoading] = useState(false)

  const sessionIdsRef = useRef<Map<string, string>>(new Map())
  const callNamesRef = useRef<Map<string, string>>(new Map())
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

  // 连接建立后订阅 events.mux（多路复用：该账号所有会话的下行事件经此流推送）。
  // host 端 api-bridge 只在收到 subscribe 帧后才开始推 downstream，故必须显式订阅。
  useEffect(() => {
    if (state !== "connected") return
    const unsub = deepcClient.subscribe("mux", () => {})
    return unsub
  }, [state])

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
          return { ...base, blocks: applyStreamChunk(base.blocks, chunk) }
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
          setMessages((prev) => [
            ...prev,
            { kind: "user", seq: event.seq, time: event.time, content, source: d.source },
          ])
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
        // turn 兜底边界：任何残留的流式指示器在此关闭。
        setStreaming(null)
        break
      }
      default:
        // turn/start、assistant 之外的 chunk、approval/* 等忽略
        break
    }
  }

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

  // 合并渲染节点：已固化消息 + 当前流式 assistant（打字机）。
  const renderNodes = useMemo(() => {
    if (!streaming || streaming.blocks.length === 0) return messages
    return [
      ...messages,
      {
        kind: "assistant" as const,
        seq: streaming.seq,
        time: streaming.time,
        turn: streaming.turn,
        step: streaming.step,
        blocks: streaming.blocks,
      },
    ]
  }, [messages, streaming])

  return {
    state,
    hostInfo,
    theme,
    error,
    workspaces,
    sessions,
    activeSessionId,
    messages: renderNodes,
    isStreaming: streaming !== null,
    loading,
    connectToNode,
    disconnect,
    selectSession,
    sendPrompt,
    loadWorkspace,
  }
}
