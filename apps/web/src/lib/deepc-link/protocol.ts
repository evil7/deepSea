// ---------------------------------------------------------------------------
// deepc-link 浏览器端帧协议类型 —— 与 packages/deepc-link/src/protocol.ts 对齐。
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
  cmd: "deepc:ping" | "deepc:pong" | "deepc:bye"
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
  /** 本机主机名（node os.hostname；插件 node 端注入，浏览器拿不到）。 */
  hostname?: string
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

/** 主站 → host 的 hello 握手确认。 */
export interface HelloAckFrame {
  kind: "hello-ack"
  protocolVersion: number
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
  | HelloAckFrame

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
  /** 挂起的交互（提问/审批等待回答），用于侧栏「等待回答」badge。 */
  pendingInteraction?: PendingKind | null
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

/** 内容块（宽松：text/reasoning/tool-call/image/tool-result 及未知）。 */
export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: string
  toolCallId?: string
  content?: ContentBlock[]
  isError?: boolean
  mediaType?: string
  data?: string
  [key: string]: unknown
}

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "image"; attachment: unknown }
  | { kind: "tool-call"; callId: string; name: string; argsRaw: string }
  | { kind: "other"; block: unknown }

/** 上下文注入 source 的 section（如 sandbox:policy / approval:policy / snapshot）。 */
export interface ContextSection {
  name?: string
  text?: string
}

/** 上下文注入的 form（对齐 dsh-llm `ContextFormed`，与 kind 独立）。 */
export type ContextForm =
  | "instructions"
  | "catalog"
  | "snapshot"
  | "notice"
  | "relay"
  | "recall"

/**
 * 上下文注入消息 source（对齐 dsh-llm `MessageSource` / `ContextFormed`）。
 * 官方是 merge-extensible sum type，kind 可为 user/plugin/model/tool 及插件扩展
 * （如 goal）。凡 kind !== 'user' 都视为注入上下文，渲染为 context 节点。
 */
export interface ContextSource {
  kind?: string
  plugin?: string
  form?: ContextForm
  /** form === 'snapshot' 时的命名贡献，按序。 */
  sections?: ContextSection[]
  /** form === 'notice' 时的一行摘要（≤120 字符）。 */
  summary?: string
  paths?: string[]
  [key: string]: unknown
}

// ── 流式输出（对齐 dsh `StreamChunk` 协议）────────────────────────────
// assistant/chunk 事件的 data.chunk 字段；按 index 累积 delta 拼出完整块。
//   · block-start      —— 打开一个内容块（text/reasoning/tool-call）
//   · text-delta       —— 追加可见文本
//   · reasoning-delta  —— 追加思考文本
//   · tool-call-delta  —— 追加工具调用参数（id/name 首次 delta 携带）
//   · block-end        —— 携带完整组装好的 ContentBlock（最终态）
//   · usage / finish   —— 用量与结束标记（渲染可忽略）
/** 错误详情（finish 分块的 failure / turn-end 的 error）。 */
export interface TurnError {
  message?: string
  code?: string
}

/** finish 分块的 reason（kind === "error" 时 failure 携带错误；"stop" 为正常结束）。 */
export interface FinishReason {
  kind: string
  failure?: TurnError
}

export type StreamChunk =
  | { type: "block-start"; index: number; blockType: "text" | "reasoning" | "tool-call" }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: ContentBlock }
  | { type: "usage"; usage: unknown }
  | { type: "finish"; reason: FinishReason }

/** assistant/chunk 事件 data（宽松）。 */
export interface AssistantChunkData {
  turn?: number
  step?: number
  chunk?: StreamChunk
}

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

/** 提问选项（ask_user_question tool 渲染的选项）。 */
export interface AskUserQuestionOption {
  label: string
  description?: string
}

/** 单个提问项（对齐 dsh `AskUserQuestionItem`）。 */
export interface AskUserQuestionItem {
  id: string
  question: string
  /** 辅助文本（渲染但不作选项）。 */
  detail?: string
  /** 短标题/分组标签。 */
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
  /** plan-review 意图：{ kind:'plan-review'; approve:string } */
  intent?: { kind: "plan-review"; approve: string } | { kind: string; [k: string]: unknown }
}

/** 提问回答（用户提交的答案）。 */
export interface AskUserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

export interface QuestionRequestedFrame {
  type: "question/requested"
  sessionId: string
  questions: AskUserQuestionItem[]
}

/** 会话挂起的交互类型（pending / PendingWait）。 */
export type PendingKind = "question" | "approval" | string

/** 会话挂起的交互（渲染侧栏「等待回答」badge / composer 接管）。 */
export interface PendingInteraction {
  kind: PendingKind
  /** question：问题 id；approval：approvalId。 */
  id: string
  /** 待答问题列表（question 时为完整 questions）。 */
  questions?: AskUserQuestionItem[]
  /** approval 时待审批的工具名 / 理由。 */
  toolName?: string
  reason?: string
}

export type MuxFrame =
  | SessionEventFrame
  | SessionSubscribedFrame
  | ApprovalRequestedFrame
  | QuestionRequestedFrame
  | { type: string; [key: string]: unknown }

// ── 设置（对齐 host-apiproxy settings.schema）───────────────────────────
// settings.describe 返回每个 namespace 的 schema envelope + resolved value +
// 三层（base/user）+ revision，供配置 UI 渲染真实动态值并带 revision 写入。

export interface SettingsSecretView {
  path: string[]
  set: boolean
}

export interface SettingsNamespaceView {
  ns: string
  /** schemastery `schema.toJSON()` envelope（可据此渲染字段/枚举）。 */
  schema: unknown
  /** 当前 resolved value（schema defaults → base → user 三层叠加）。 */
  value: unknown
  base?: unknown
  user?: unknown
  applies: "live" | "restart"
  secrets: SettingsSecretView[]
  /** 单调 revision：写入时作为 expectedRevision 防冲突。 */
  revision: number
}

export interface SettingsDescribeView {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
}

/** settings.update 响应：被更新 namespace 的新 view（redacted）。 */
export type SettingsUpdateView = SettingsNamespaceView

// ── 插件清单（对齐 host-plugin-inventory `pluginInventory/list` Remote）──
// 注意：这是 typert Remote，调用 payload 为 { args: {} }，method 名为斜杠
// `pluginInventory/list`（区别于 gateway scoped 点号 method）。

export type PluginFiberPhase =
  | "pending"
  | "loading"
  | "active"
  | "failed"
  | "unloading"
  | null

export interface PluginInventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: PluginFiberPhase
}

export interface PluginInventorySnapshot {
  entries: PluginInventoryEntry[]
}

/** llm-deepseek 里暴露的可选模型（name 为显示名，id 为模型 id）。 */
export interface ModelCatalogEntry {
  id: string
  name: string
  contextWindow?: number
  inputModalities?: string[]
  [key: string]: unknown
}

// ── 会话模型（对齐 host-apiproxy sessions.schema session.models）──────────

/** 推理等级枚举项。 */
export interface ReasoningEffortEntry {
  id: string
  name: string
}

/** 单个模型（含推理等级配置）。 */
export interface SessionModelEntry {
  id: string
  name: string
  reasoning?: { efforts?: ReasoningEffortEntry[]; defaultEffort?: string }
}

/** 一个 provider 分组。 */
export interface ModelProviderGroup {
  id: string
  name: string
  models: SessionModelEntry[]
}

/** session.models 响应值。 */
export interface SessionModelsView {
  current: ModelSelection
  routable: boolean
  groups: ModelProviderGroup[]
  failures: unknown[]
}

// ── host 级 remote 事件（对齐 events.host 的 host/remote-event 帧）─────────
// 事件名见 API_REMOTE_FORWARDED_EVENTS；settings/document-updated args 为 [ns, revision]。

export interface HostRemoteEventFrame {
  type: "host/remote-event"
  event: string
  args: unknown[]
}
