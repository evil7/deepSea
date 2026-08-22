/**
 * deepc-bridge —— 帧协议定义（纯类型 + 常量，无运行时依赖）。
 *
 * 桥接层只做 JSON 透传，不做业务校验（dsh 两侧已用 zod 双向校验）。
 * 信封结构严格对齐 dsh host/apiproxy 的四象限信封，保证可直连调用。
 *
 * 两类应用帧复用同一条 DataChannel（靠 kind 路由）：
 *   操作互联：unary / subscribe / downstream（chatUI → 本地 dsh API）
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

/** 本地 → 远端：下行流结束。 */
export interface DownstreamEndFrame {
  kind: 'downstream-end'
  subId: string
}

/** 私有控制命令：deepc:ping（探活请求）/ deepc:pong（探活应答）/ deepc:bye（主动断开通知）。 */
export type ControlCmd = 'deepc:ping' | 'deepc:pong' | 'deepc:bye'

/**
 * 控制面心跳帧（deepc 私有通道，不经 dsh API）。
 * 连接建立后由本地端（host）发起 deepc:ping，远端（client）回 deepc:pong；
 * 回复超时后双端进入互相探测，确认失效即回调 onDead 触发状态自动变更。
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
  | DownstreamEndFrame
  | ControlFrame
  | HelloFrame
  | HelloAckFrame
  | ThemeStateFrame
  | SyncHelloFrame
  | SyncHelloAckFrame
  | SyncFileMetaFrame
  | SyncFileFrame
  | SyncFileAckFrame
  | SyncFileNackFrame
  | SyncEndFrame
  | SyncDoneFrame

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

/**
 * 主题状态推送帧（node → chatUI）：连接后随 hello 或主题变更时下发。
 * theme 为 settings 里 theme 命名空间的 value（passthrough，不深校验）。
 */
export interface ThemeStateFrame {
  kind: 'theme-state'
  theme: unknown
}

// ---------------------------------------------------------------------------
// 工程同步帧（工作区 + 聊天记录经自动分包传输）
// ---------------------------------------------------------------------------

/** 同步流握手（host 发起）：txId 会话边界，chunkBytes 分块大小，scope 同步对象。 */
export interface SyncHelloFrame {
  kind: 'sync-hello'
  txId: string
  chunkBytes: number
  /** 同步对象范围：workspace（工作区）/ sessions（聊天记录）。 */
  scope: 'workspace' | 'sessions'
  total: number
}

/** 握手应答（peer 回）：确认 txId + 协商后的 chunkBytes。 */
export interface SyncHelloAckFrame {
  kind: 'sync-hello-ack'
  txId: string
  chunkBytes: number
}

/**
 * 单文件/记录元信息（发送端在分块前发出，作为校验基准）：
 * size = 原始字节数，chunks = 分块数，sha256 = 全量 SHA-256 hex（小写）。
 */
export interface SyncFileMetaFrame {
  kind: 'sync-file-meta'
  txId: string
  path: string
  mime: string
  size: number
  chunks: number
  sha256: string
}

/** 单文件/记录分块帧：data 为单个分块的 base64，chunk 为排序标号（0-based）。 */
export interface SyncFileFrame {
  kind: 'sync-file'
  txId: string
  path: string
  chunk: number
  data: string
}

/** 单文件确认：收齐 + hash 校验通过。 */
export interface SyncFileAckFrame {
  kind: 'sync-file-ack'
  txId: string
  path: string
}

/** 单文件否定：缺块/损坏 → 请求重发 missing 标号块。 */
export interface SyncFileNackFrame {
  kind: 'sync-file-nack'
  txId: string
  path: string
  missing: number[]
}

/** 同步流结束（发送端告知全部已发）。 */
export interface SyncEndFrame {
  kind: 'sync-end'
  txId: string
}

/** 完成告知（接收端告知结束）：received/failed 统计。 */
export interface SyncDoneFrame {
  kind: 'sync-done'
  txId: string
  received: number
  failed: number
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** API 路径前缀（WebApiClient.resolveBase() 之后同源拼接）。 */
export const API_PREFIX = '/api/'

/**
 * 工程同步分块大小（原始字节）：16KB，base64 后 ~22KB，远低于 DataChannel
 * 单消息上限（Chrome 256KB / Firefox 64KB）。
 */
export const SYNC_CHUNK_BYTES = 16 * 1024

/** 背压高水位：DC 缓冲超过此值暂停发送，等待排空（防洪水撑爆连接）。 */
export const SYNC_BUFFER_HIGH = 512 * 1024

/** 背压低水位：缓冲降到该值以下才继续发送。 */
export const SYNC_BUFFER_LOW = 128 * 1024

/** 同步流握手超时：host 等 hello-ack 的最长等待。 */
export const SYNC_HELLO_TIMEOUT_MS = 10_000

/** 单文件收齐超时：receiver 超时未收齐 → NACK 缺块标号。 */
export const SYNC_FILE_TIMEOUT_MS = 30_000

/** 整体结束超时：sender 等 done / 整体兜底。 */
export const SYNC_END_TIMEOUT_MS = 30_000

/** 单文件 NACK 重发最大轮次（防损坏文件死循环）。 */
export const SYNC_MAX_NACK_ROUNDS = 3

/** 上行 unary 请求路径（POST /api/{method}）。 */
export const MUX_STREAM = 'events.mux'
export const HOST_STREAM = 'events.host'

/** 判断 URL 是否为上行 unary 请求（POST /api/{method}，非 events 流）。 */
export function isUnaryUrl(url: string): boolean {
  return url.includes(API_PREFIX) && !isDownstreamUrl(url)
}

/** 判断 URL 是否为下行事件流（/api/events.mux 或 /api/events.host）。 */
export function isDownstreamUrl(url: string): boolean {
  return url.includes(`/${MUX_STREAM}`) || url.includes(`/${HOST_STREAM}`)
}

/** 从下行 URL 提取流类型。 */
export function streamKindFromUrl(url: string): StreamKind {
  return url.includes(`/${MUX_STREAM}`) ? 'mux' : 'host'
}
