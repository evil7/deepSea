// ---------------------------------------------------------------------------
// deepc-bridge 浏览器端帧协议类型 —— 与 packages/deepc-bridge/src/protocol.ts 对齐。
//
// 主站 chatUI（apps/web）是独立部署单元，这里定义一份轻量但类型安全的协议
// 视图：DataChannel 帧 + 会话/工作区/消息数据形态。信令与帧结构是稳定契约，
// 与本地插件端严格一致（详见 docs/deepsea-deepc-bridge-plan.md §5）。
// ---------------------------------------------------------------------------

// ── RPC 信封 ──────────────────────────────────────────────────────────────

export interface RpcError {
  code: string
  message: string
  details?: unknown
}

export type RpcResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: RpcError }

// ── 数据面帧 ──────────────────────────────────────────────────────────────

export type StreamKind = "mux" | "host"

export interface UnaryFrame {
  kind: "unary"
  rpcId: string
  method: string
  payload: unknown
}

export interface UnaryResultFrame {
  kind: "unary-result"
  rpcId: string
  result: RpcResult
}

export interface SubscribeFrame {
  kind: "subscribe"
  subId: string
  stream: StreamKind
}

export interface UnsubscribeFrame {
  kind: "unsubscribe"
  subId: string
}

/** 下行帧：完整 server-request 信封（type/rpcId/method/payload）。 */
export interface ServerRequest {
  type: "server-request"
  rpcId: string
  method: string
  payload: unknown
}

export interface DownstreamFrame {
  kind: "downstream"
  subId: string
  envelope: ServerRequest
}

export interface ControlFrame {
  kind: "control"
  cmd: "deepc:ping" | "deepc:pong"
  seq: number
  ts: number
}

// ── 握手 / 基础信息对齐 ───────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1

export interface HostInfo {
  version: string
  cwd: string
  provider?: string
  model?: string
  attachedSessions: number
  home: string
  canOpenPath: boolean
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface HelloFrame {
  kind: "hello"
  protocolVersion: number
  host: HostInfo
  theme: unknown
  model?: ModelSelection
}

export interface ThemeStateFrame {
  kind: "theme-state"
  theme: unknown
}

// ── 帧联合类型 ────────────────────────────────────────────────────────────

export type BridgeFrame =
  | UnaryFrame
  | UnaryResultFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | DownstreamFrame
  | ControlFrame
  | HelloFrame
  | ThemeStateFrame

// ── 会话 / 工作区数据（对齐 dsh-host-apiproxy schema）─────────────────────

export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: "subagent"
  cwd?: string
  agentPreset?: string
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

/** SessionEvent：严格信封 + 宽 data（会话事件流的基本单元）。 */
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
  ignorable?: true
}

export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

// ── 消息内容块（对齐 dsh-llm ContentBlock 分类）───────────────────────────

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "image"; attachment: unknown }
  | { kind: "tool-call"; callId: string; name: string; argsRaw: string }
  | { kind: "other"; block: unknown }

export interface AssistantMessageNode {
  kind: "assistant"
  seq: number
  messageId?: string
  time: number
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
  usage?: unknown
  provenance?: { provider: string; model: string }
  requestConfig?: { provider: string; model: string; thinking?: string }
  interrupted?: true
}

export interface UserMessageNode {
  kind: "user"
  seq: number
  time: number
  content: readonly unknown[]
  source: unknown
}

export interface ToolResultNode {
  kind: "tool-result"
  seq: number
  time: number
  callId: string
  call: { name: string; argsRaw: string } | null
  content: readonly unknown[]
  isError: boolean
}

/** 折叠后的对话节点（chatUI 消息流渲染单元）。 */
export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | ToolResultNode
  | { kind: "other"; seq: number; time: number; type: string; data: unknown }

// ── 下行事件 payload（对齐 events.schema）─────────────────────────────────

export interface SessionEventFrame {
  type: "session/event"
  sessionId: string
  event: SessionEvent
  view?: unknown
}

export interface SessionSubscribedFrame {
  type: "session/subscribed"
  sessionId: string
  lastSeq: number
}

export interface ApprovalRequestedFrame {
  type: "approval/requested"
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface QuestionRequestedFrame {
  type: "question/requested"
  sessionId: string
  questions: unknown[]
}

export type MuxFrame =
  | SessionEventFrame
  | SessionSubscribedFrame
  | ApprovalRequestedFrame
  | QuestionRequestedFrame
  | { type: string; [key: string]: unknown }
