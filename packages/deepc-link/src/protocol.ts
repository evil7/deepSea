/**
 * deepc-link —— 帧协议定义（纯类型 + 常量，无运行时依赖）。
 *
 * 桥接层只做 JSON 透传，不做业务校验（dsh 两侧已用 zod 双向校验）。
 * 信封结构严格对齐 dsh host/apiproxy 的四象限信封，保证可直连调用。
 *
 * 两类应用帧复用同一条 DataChannel（靠 kind 路由）：
 *   多端互联：unary / subscribe / downstream（chatUI → 本地 dsh API）
 *   工程同步：sync-*（工作区 + 聊天记录经自动分包传输）
 */

// ---------------------------------------------------------------------------
// dsh 四象限信封（与 host/apiproxy/lib/types/api/*.schema.js 对齐）
// ---------------------------------------------------------------------------

/** RPC 错误对象（rpcErrorSchema 的宽松子集，透传不校验）。 */
export interface RpcError {
  code: string
  message: string
  details?: unknown
}

/** RpcResult<T>：成功带 value，失败带 error。 */
export type RpcResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: RpcError }

/** C→S 上行请求信封。 */
export interface ClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

/** S→C 上行响应信封。 */
export interface ServerResponse {
  type: 'server-response'
  rpcId: string
  result: RpcResult
}

/** S→C 下行帧信封（events.mux / events.host 的 WebSocket 帧）。 */
export interface ServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

// ---------------------------------------------------------------------------
// 桥接帧（DataChannel 上传输的封装）
// ---------------------------------------------------------------------------

/** 下行流标识：events.mux 或 events.host。 */
export type StreamKind = 'mux' | 'host'

/** 远端 → 本地：上行 unary 请求。 */
export interface UnaryFrame {
  kind: 'unary'
  rpcId: string
  method: string
  payload: unknown
}

/** 本地 → 远端：上行 unary 响应。 */
export interface UnaryResultFrame {
  kind: 'unary-result'
  rpcId: string
  result: RpcResult
}

/** 远端 → 本地：订阅下行流。 */
export interface SubscribeFrame {
  kind: 'subscribe'
  subId: string
  stream: StreamKind
}

/** 远端 → 本地：取消订阅下行流。 */
export interface UnsubscribeFrame {
  kind: 'unsubscribe'
  subId: string
}

/** 本地 → 远端：下行帧（完整 server-request 信封透传）。 */
export interface DownstreamFrame {
  kind: 'downstream'
  subId: string
  envelope: ServerRequest
}

/** 私有控制命令：deepc:bye（主动断开通知）。 */
export type ControlCmd = 'deepc:bye'

/**
 * 控制面断开通知帧（deepc 私有通道，不经 dsh API）。
 * 任一端主动断开前发 deepc:bye，对端据此不触发自动重连。
 */
export interface ControlFrame {
  kind: 'control'
  cmd: ControlCmd
  seq: number
  ts: number
}

/** 桥接帧联合类型。 */
export type BridgeFrame =
  | UnaryFrame
  | UnaryResultFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | DownstreamFrame
  | ControlFrame
  | HelloFrame
  | HelloAckFrame
  | ChunkMetaFrame
  | ChunkFrame

// ---------------------------------------------------------------------------
// 连接握手 + 基础信息对齐（node → chatUI）
// ---------------------------------------------------------------------------

/** 协议版本（hello/hello-ack 交换，向前兼容基准）。 */
export const PROTOCOL_VERSION = 1

/** host.describe 的响应值（对齐 host.schema.js hostDescribeValueSchema）。 */
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

/** 模型选择（对齐 session.models 的 current）。 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * 连接建立后的握手帧（node 端主动推送）：一次性对齐基础信息，
 * chatUI 无需逐个 unary 即可渲染 host 元信息 / 主题 / 模型。
 */
export interface HelloFrame {
  kind: 'hello'
  protocolVersion: number
  host: HostInfo
  theme: unknown
  model?: ModelSelection
}

/** 握手确认帧（chatUI → node）。 */
export interface HelloAckFrame {
  kind: 'hello-ack'
  protocolVersion: number
}

// ---------------------------------------------------------------------------
// 大帧自动分包（通用）：把超限的桥梁帧（如 session.history 的 unary-result /
// 大 downstream 帧）拆成多个 chunk 帧发送，对端重组后按原帧路由。
// 触发条件：整帧 JSON 长度 > CHUNK_THRESHOLD_BYTES。
// ---------------------------------------------------------------------------

/** 分包元信息（发送端在某帧超限时先发）：确定重组边界与校验基准。 */
export interface ChunkMetaFrame {
  kind: 'chunk-meta'
  /** 本次分包会话 id（隔离串批帧）。 */
  txId: string
  /** 重组后的完整帧 JSON 字节数。 */
  total: number
  /** 分块数。 */
  chunks: number
  /** 完整帧 JSON 的 SHA-256 hex（小写；subtle 不可用时空串，对端仅按 size 校验）。 */
  sha256: string
}

/** 分包数据帧：data 为单个分块的 base64。 */
export interface ChunkFrame {
  kind: 'chunk'
  txId: string
  index: number
  data: string
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
