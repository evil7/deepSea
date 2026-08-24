// ---------------------------------------------------------------------------
// deepc-link 浏览器端客户端（主站 chatUI 连接本地 dsh 的入口）。
//
// 职责：
//   · connectToNode(target, self)：多端直连（信箱式信令）建立 WebRTC DataChannel
//   · call(method, payload)：unary 调用本地 dsh API，返回 RpcResult
//   · subscribe(stream, handler)：订阅下行事件流（events.mux / events.host）
//   · on(event, handler)：连接状态 / hello / downstream 事件分发
//
// 帧协议与 packages/deepc-link 严格对齐；信令走 Worker /ws/api-link（DO 推送）。
// ---------------------------------------------------------------------------

import {
  decryptSignal,
  deriveNodeSignalKey,
  encryptSignal,
} from "./crypto"
import {
  decodeNodeEnvelope,
  encodeNodeEnvelope,
} from "./nodes"
import { createWsLinkClient, type WsLinkClient } from "./ws-signaling"
import type {
  BridgeFrame,
  ChunkFrame,
  ChunkMetaFrame,
  DownstreamFrame,
  HelloFrame,
  RpcResult,
  StreamKind,
} from "./protocol"
import { PROTOCOL_VERSION } from "./protocol"

const ICE_SERVERS: RTCConfiguration["iceServers"] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]

export type ClientState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "disconnected"

/** 客户端事件（连接状态 + 数据帧）。 */
export interface ClientEvents {
  state: ClientState
  hello: HelloFrame
  downstream: DownstreamFrame
  error: string
}

type Handler<T> = (payload: T) => void

interface PendingUnary {
  resolve: (result: RpcResult) => void
  timer: ReturnType<typeof setTimeout>
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/** 最近一次连接的意图（sessionStorage 持久化，供页面刷新后自动恢复）。 */
interface LastConnection {
  target: string
  self: string
}

const LAST_CONNECTION_KEY = "deepc.lastConnection"

function readLastConnection(): LastConnection | null {
  try {
    const raw = sessionStorage.getItem(LAST_CONNECTION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastConnection
    if (typeof parsed.target === "string" && typeof parsed.self === "string") {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function writeLastConnection(conn: LastConnection): void {
  try {
    sessionStorage.setItem(LAST_CONNECTION_KEY, JSON.stringify(conn))
  } catch {
    // 忽略（隐私模式等）
  }
}

function clearLastConnection(): void {
  try {
    sessionStorage.removeItem(LAST_CONNECTION_KEY)
  } catch {
    // 忽略
  }
}

// ── 大帧自动分包（send 侧）─────────────────────────────────────────────────
// 规避 SCTP 单消息超限崩溃：session.history 等大 unary-result / 大 downstream 帧
// 会超过 DataChannel 单消息上限。超限时拆成 chunk-meta + chunk×N，对端重组。
const MAX_FRAME_BYTES = 16 * 1024
// chunk 的 data 经 base64 膨胀 4/3，再套 JSON 包装；为保证 chunk 帧 JSON < 16KB
// （对齐 peerjs chunkedMTU=16300，避开 Firefox→Chrome 16384 截断），取 12000。
const CHUNK_BYTES = 12000

function toBase64Bytes(buf: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function fromBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function concatBytesArr(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

async function sha256HexStr(bytes: Uint8Array): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return ""
    const digest = await subtle.digest("SHA-256", bytes.slice())
    const arr = new Uint8Array(digest)
    let hex = ""
    for (const b of arr) hex += b.toString(16).padStart(2, "0")
    return hex
  } catch {
    return ""
  }
}

function createTxId(): string {
  const bytes = new Uint8Array(8)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return hex
}

export class DeepcClient {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private _state: ClientState = "idle"
  private _connectedAt: number | null = null
  private wsSignal: WsLinkClient | null = null

  /** 进行中的分块重组：txId → { total, chunks, sha256, slots, received }。 */
  private chunkBuf = new Map<
    string,
    { total: number; chunks: number; sha256: string; slots: (Uint8Array | null)[]; received: number }
  >()

  // 意外断连自动恢复：记住「连谁 + 我是谁」，dc close 后固定间隔重连。
  // 断联 3 次（每次 10s，共 30s）后清除意图，进入 error 态（由页面负责回首页）。
  private lastTarget: string | null = null
  private lastSelf: string | null = null
  private userDisconnect = false
  private connectionGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0

  private unaryPending = new Map<string, PendingUnary>()
  private subHandlers = new Map<string, Handler<DownstreamFrame>>()
  private listeners: { [K in keyof ClientEvents]: Set<Handler<ClientEvents[K]>> } = {
    state: new Set(),
    hello: new Set(),
    downstream: new Set(),
    error: new Set(),
  }

  get state(): ClientState {
    return this._state
  }

  /** 最近一次成功建立连接的时间戳（ms）；断开/重连/失败时为 null。 */
  get connectedAt(): number | null {
    return this._connectedAt
  }

  private setState(state: ClientState): void {
    this._state = state
    // 记录连接建立时刻：进入 connected 时打戳，其余状态一律清除，
    // 供 chatUI sidebar 展示「时长 + 状态」（重连中/失败时不显示时长）。
    if (state === "connected") {
      this._connectedAt = Date.now()
    } else {
      this._connectedAt = null
    }
    this.emit("state", state)
  }

  /** 订阅事件，返回取消函数。 */
  on<K extends keyof ClientEvents>(event: K, handler: Handler<ClientEvents[K]>): () => void {
    this.listeners[event].add(handler)
    return () => this.listeners[event].delete(handler)
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    for (const handler of this.listeners[event]) handler(payload)
  }

  /** 断开连接（用户主动）。发送 deepc:bye 通知远端，清除重连意图，不再自动恢复。 */
  disconnect(): void {
    this.userDisconnect = true
    this.connectionGeneration++
    this.cancelReconnect()
    // 通知远端「主动断开」——远端收到后标记 userDisconnect，不触发自动重连。
    this.send({ kind: "control", cmd: "deepc:bye", seq: 0, ts: Date.now() })
    this.lastTarget = null
    this.lastSelf = null
    clearLastConnection()
    this.dispose()
    this.setState("disconnected")
  }

  /**
   * 页面加载后尝试恢复上次连接（vite full reload / 手滑刷新后自动重连）。
   * 仅当当前未连接且存在持久化意图时生效。
   */
  resumeLastConnection(): void {
    if (
      this._state === "connected" ||
      this._state === "connecting" ||
      this._state === "reconnecting"
    ) {
      return
    }
    const conn = readLastConnection()
    if (!conn) return
    void this.connectToNode(conn.target, conn.self)
  }

  /** 意外断连后的固定间隔重连：每 10s 尝试一次，最多 3 次（共 30s）。 */
  private readonly MAX_RECONNECT_ATTEMPTS = 3
  private readonly RECONNECT_INTERVAL_MS = 10_000

  private scheduleReconnect(): void {
    if (this.userDisconnect) return
    if (!this.lastTarget || !this.lastSelf) return
    if (this.reconnectTimer) return
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      // 重试耗尽（60s）：目标仍未就绪，停止重连，清除连接意图，回到失败态。
      this.lastTarget = null
      this.lastSelf = null
      clearLastConnection()
      this.setState("error")
      return
    }
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectToNode(this.lastTarget!, this.lastSelf!)
    }, this.RECONNECT_INTERVAL_MS)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = 0
  }

  /**
   * 多端直连：向目标 nodeId 投递 offer（发起方）。
   * 主站 /links 点设备卡片时调用；selfNodeId 为主站控制端节点（answer 回投地址）。
   * 信令走 WS（DO 推送）。
   */
  async connectToNode(targetNodeId: string, selfNodeId: string): Promise<void> {
    // 记录连接代际：disconnect() 会使代际 +1，从而让「进行中」的本次连接流程失效
    // （异步 await 期间用户点断开，本流程完成后不得再覆盖 disconnected 状态）。
    const gen = this.connectionGeneration
    // 记录连接意图（意外断连后据此自动重连）。
    this.lastTarget = targetNodeId
    this.lastSelf = selfNodeId
    this.userDisconnect = false
    // 首次连接显示「连接中」；自动重连期间保持「重连中」状态（不闪回设备列表）。
    if (this._state !== "reconnecting") {
      this.setState("connecting")
    }

    const key = await deriveNodeSignalKey(targetNodeId)
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const dc = pc.createDataChannel("deepc", { ordered: true })
    this.pc = pc
    this.dc = dc

    // 连接失败：清理 + 上报 + 调度自动重连。
    // 无论首次还是重连失败，都进入「重连中」持续重试——dsh 刷新后插件端 mailbox-host
    // 的 WS 长连接需数秒重建，此时发 offer 会无人接收丢失，靠重试等待插件端就绪。
    const fail = (msg: string): void => {
      pc.close()
      this.pc = null
      this.dc = null
      this.wsSignal?.disconnect()
      this.wsSignal = null
      // 本次连接流程已失效（用户中途断开）：不再改变状态 / 调度重连。
      if (gen !== this.connectionGeneration) return
      this.emit("error", msg)
      this.setState("reconnecting")
      this.scheduleReconnect()
    }

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await this.waitIceComplete(pc)

      const offerSdp = pc.localDescription?.sdp ?? ""
      const cipher = await encryptSignal(key, offerSdp)
      const envelope = encodeNodeEnvelope(selfNodeId, cipher)
      const answerKey = await deriveNodeSignalKey(selfNodeId)

      // WS 信令（DO 推送）：建连 + 投递 offer + 等 answer 推送。
      const wsClient = createWsLinkClient()
      this.wsSignal = wsClient
      const wsOk = await wsClient.connect(selfNodeId)

      let answerRaw: string | null = null
      if (wsOk) {
        // WS 投递 offer + 等 answer 推送。统一 15s 超时（插件端就绪通常数秒；
        // 失败后由 scheduleReconnect 指数退避重试，无需长超时阻塞）。
        const answerTimeoutMs = 15_000
        const answerPromise = new Promise<string | null>((resolve) => {
          const off = wsClient.onSignal((_from, kind, payload) => {
            if (kind !== "answer") return
            off()
            clearTimeout(timer)
            resolve(payload)
          })
          const timer = setTimeout(() => {
            off()
            resolve(null)
          }, answerTimeoutMs)
        })
        wsClient.send(targetNodeId, "offer", envelope)
        answerRaw = await answerPromise
      } else {
        fail("信令连接失败")
        return
      }

      if (answerRaw === null) {
        fail("等待 answer 超时")
        return
      }
      const env = decodeNodeEnvelope(answerRaw)
      if (env === null) {
        fail("answer 信封非法")
        return
      }
      const answerSdp = await decryptSignal(answerKey, env.sdp)
      if (answerSdp === null) {
        fail("answer 解密失败")
        return
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp })
      await this.waitDataChannelOpen(dc)

      // 连接建立完成，但本次流程可能已失效（用户中途断开）：静默清理，不改状态。
      if (gen !== this.connectionGeneration) {
        pc.close()
        this.pc = null
        this.dc = null
        return
      }

      dc.addEventListener("message", (ev) => this.onMessage(ev))
      dc.addEventListener("close", () => {
        this.dispose()
        if (this.userDisconnect) {
          // 用户主动断开：disconnect() 已 setState("disconnected")，这里保持不动。
          this.setState("disconnected")
        } else {
          // 意外断开 → 进入重连态并自动恢复。
          this.setState("reconnecting")
          this.scheduleReconnect()
        }
      })

      this.cancelReconnect()
      writeLastConnection({ target: targetNodeId, self: selfNodeId })
      this.setState("connected")
      // 握手确认：回应 node 端 hello。
      this.send({ kind: "hello-ack", protocolVersion: PROTOCOL_VERSION } as BridgeFrame)
    } catch {
      fail("连接超时")
    }
  }

  private dispose(): void {
    for (const p of this.unaryPending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: { code: "disconnected", message: "连接已断开" } })
    }
    this.unaryPending.clear()
    this.subHandlers.clear()
    this.chunkBuf.clear()
    this.wsSignal?.disconnect()
    this.wsSignal = null
    this.dc?.close()
    this.pc?.close()
    this.dc = null
    this.pc = null
  }

  /** unary 调用本地 dsh API，返回 RpcResult。 */
  call(method: string, payload: unknown, timeoutMs = 30_000): Promise<RpcResult> {
    if (!this.dc || this.dc.readyState !== "open") {
      return Promise.resolve({
        ok: false,
        error: { code: "not-connected", message: "未连接" },
      })
    }
    const rpcId = uid("rpc")
    return new Promise<RpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.unaryPending.delete(rpcId)
        resolve({ ok: false, error: { code: "timeout", message: `调用 ${method} 超时` } })
      }, timeoutMs)
      this.unaryPending.set(rpcId, { resolve, timer })
      this.send({ kind: "unary", rpcId, method, payload })
    })
  }

  /** 订阅下行事件流，返回取消函数。 */
  subscribe(stream: StreamKind, handler: Handler<DownstreamFrame>): () => void {
    if (!this.dc || this.dc.readyState !== "open") return () => {}
    const subId = uid("sub")
    this.subHandlers.set(subId, handler)
    this.send({ kind: "subscribe", subId, stream })
    return () => {
      this.subHandlers.delete(subId)
      this.send({ kind: "unsubscribe", subId })
    }
  }

  private send(frame: BridgeFrame): void {
    if (!this.dc || this.dc.readyState !== "open") return
    const json = JSON.stringify(frame)
    if (json.length <= MAX_FRAME_BYTES) {
      this.dc.send(json)
      return
    }
    // 大帧分包：chunk-meta + chunk×N（规避 SCTP 单消息超限崩溃）。
    // meta.sha256 留空（subtle 异步无法同步先算），对端按 total（size）兜底校验。
    const bytes = new TextEncoder().encode(json)
    const txId = createTxId()
    const chunks = Math.ceil(bytes.length / CHUNK_BYTES)
    const meta: ChunkMetaFrame = { kind: "chunk-meta", txId, total: bytes.length, chunks, sha256: "" }
    this.dc.send(JSON.stringify(meta))
    for (let i = 0; i < chunks; i++) {
      const slice = bytes.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, bytes.length))
      const chunk: ChunkFrame = { kind: "chunk", txId, index: i, data: toBase64Bytes(slice) }
      this.dc.send(JSON.stringify(chunk))
    }
  }

  private onMessage(event: MessageEvent): void {
    let frame: BridgeFrame
    try {
      frame = JSON.parse(String(event.data)) as BridgeFrame
    } catch {
      return
    }
    // 分包层优先：chunk-meta / chunk 帧由这里重组。
    if (frame.kind === "chunk-meta" || frame.kind === "chunk") {
      this.handleChunkFrame(frame)
      return
    }
    this.handoff(frame)
  }

  /** 处理分块帧，重组完整后分发。 */
  private handleChunkFrame(frame: ChunkMetaFrame | ChunkFrame): void {
    if (frame.kind === "chunk-meta") {
      if (frame.chunks > 512) return // 防串批/恶意
      this.chunkBuf.set(frame.txId, {
        total: frame.total,
        chunks: frame.chunks,
        sha256: frame.sha256,
        slots: new Array(frame.chunks).fill(null),
        received: 0,
      })
      return
    }
    const re = this.chunkBuf.get(frame.txId)
    if (!re) return
    if (frame.index < 0 || frame.index >= re.chunks) return
    if (re.slots[frame.index]) return
    re.slots[frame.index] = fromBase64Bytes(frame.data)
    re.received += 1
    if (re.received !== re.chunks) return
    this.chunkBuf.delete(frame.txId)
    const parts: Uint8Array[] = []
    for (let i = 0; i < re.chunks; i++) {
      const p = re.slots[i]
      if (p) parts.push(p)
    }
    const bytes = concatBytesArr(parts)
    if (re.sha256) {
      void sha256HexStr(bytes).then((h) => {
        if (h === re.sha256) this.emitReassembled(bytes, re.total)
      })
    } else if (bytes.length === re.total) {
      this.emitReassembled(bytes, re.total)
    }
  }

  /** 重组出完整帧后回到正常路由。 */
  private emitReassembled(bytes: Uint8Array, total: number): void {
    if (bytes.length !== total) return
    const json = new TextDecoder().decode(bytes)
    let frame: BridgeFrame
    try {
      frame = JSON.parse(json) as BridgeFrame
    } catch {
      return
    }
    this.handoff(frame)
  }

  private handoff(frame: BridgeFrame): void {
    switch (frame.kind) {
      case "unary-result": {
        const pending = this.unaryPending.get(frame.rpcId)
        if (pending) {
          clearTimeout(pending.timer)
          this.unaryPending.delete(frame.rpcId)
          pending.resolve(frame.result)
        }
        break
      }
      case "downstream": {
        this.emit("downstream", frame)
        const handler = this.subHandlers.get(frame.subId)
        handler?.(frame)
        break
      }
      case "hello": {
        this.emit("hello", frame)
        break
      }
      case "control": {
        if (frame.cmd === "deepc:bye") {
          // 插件端主动断开：标记用户断开，不自动重连，回到设备列表。
          this.userDisconnect = true
          this.cancelReconnect()
          this.lastTarget = null
          this.lastSelf = null
          clearLastConnection()
          this.dispose()
          this.setState("disconnected")
        }
        break
      }
      default:
        break
    }
  }

  private waitIceComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve()
    return new Promise((resolve) => {
      const onState = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", onState)
          resolve()
        }
      }
      pc.addEventListener("icegatheringstatechange", onState)
    })
  }

  /** 等待本地创建的 DataChannel 打开（发起方用）。 */
  private waitDataChannelOpen(dc: RTCDataChannel, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dc open timeout")), timeoutMs)
      const check = (): void => {
        if (dc.readyState === "open") {
          clearTimeout(timer)
          dc.removeEventListener("open", check)
          resolve()
        }
      }
      dc.addEventListener("open", check)
      check()
    })
  }
}

/** 单例（应用内共享一条连接）。 */
export const deepcClient = new DeepcClient()
