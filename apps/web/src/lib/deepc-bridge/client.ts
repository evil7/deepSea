// ---------------------------------------------------------------------------
// deepc-bridge 浏览器端客户端（主站 chatUI 连接本地 dsh 的入口）。
//
// 职责：
//   · connectToNode(target, self)：多端直连（信箱式信令）建立 WebRTC DataChannel
//   · call(method, payload)：unary 调用本地 dsh API，返回 RpcResult
//   · subscribe(stream, handler)：订阅下行事件流（events.mux / events.host）
//   · on(event, handler)：连接状态 / hello / downstream 事件分发
//
// 帧协议与 packages/deepc-bridge 严格对齐；信令走 Worker /ws/signal（DO 推送）。
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
import { createWsSignalClient, type WsSignalClient } from "./ws-signaling"
import type {
  BridgeFrame,
  DownstreamFrame,
  HelloFrame,
  RpcResult,
  StreamKind,
  ThemeStateFrame,
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
  theme: ThemeStateFrame
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

export class DeepcClient {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private _state: ClientState = "idle"
  private wsSignal: WsSignalClient | null = null

  // 意外断连自动恢复：记住「连谁 + 我是谁」，dc close 后指数退避重连。
  private lastTarget: string | null = null
  private lastSelf: string | null = null
  private userDisconnect = false
  private everConnected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0

  private unaryPending = new Map<string, PendingUnary>()
  private subHandlers = new Map<string, Handler<DownstreamFrame>>()
  private listeners: { [K in keyof ClientEvents]: Set<Handler<ClientEvents[K]>> } = {
    state: new Set(),
    hello: new Set(),
    downstream: new Set(),
    theme: new Set(),
    error: new Set(),
  }

  get state(): ClientState {
    return this._state
  }

  private setState(state: ClientState): void {
    this._state = state
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

  /** 断开连接（用户主动）。清除重连意图，不再自动恢复。 */
  disconnect(): void {
    this.userDisconnect = true
    this.everConnected = false
    this.cancelReconnect()
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
    // 持久化存在 = 之前连上过，视为「恢复」，失败也自动重试。
    this.everConnected = true
    void this.connectToNode(conn.target, conn.self)
  }

  /** 意外断连后的指数退避重连（1s→2s→4s…封顶 15s）。 */
  private scheduleReconnect(): void {
    if (this.userDisconnect) return
    if (!this.lastTarget || !this.lastSelf) return
    if (this.reconnectTimer) return
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15_000)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectToNode(this.lastTarget!, this.lastSelf!)
    }, delay)
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
   * 主站 /sonar 点设备卡片时调用；selfNodeId 为主站控制端节点（answer 回投地址）。
   * 信令走 WS（DO 推送）。
   */
  async connectToNode(targetNodeId: string, selfNodeId: string): Promise<void> {
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

    // 连接失败：清理 + 上报 + 调度自动重连（仅「曾连上过」才重连，首次失败不空转）。
    const fail = (msg: string): void => {
      pc.close()
      this.pc = null
      this.dc = null
      this.wsSignal?.disconnect()
      this.wsSignal = null
      this.emit("error", msg)
      if (this.everConnected) {
        this.setState("reconnecting")
      } else {
        this.setState("error")
      }
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
      const wsClient = createWsSignalClient()
      this.wsSignal = wsClient
      const wsOk = await wsClient.connect(selfNodeId)

      let answerRaw: string | null = null
      if (wsOk) {
        // WS 投递 offer + 等 answer 推送。重连场景用更短超时（插件端离线时快速失败重试）。
        const answerTimeoutMs = this.everConnected ? 15_000 : 60_000
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

      this.everConnected = true
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
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(frame))
    }
  }

  private onMessage(event: MessageEvent): void {
    let frame: BridgeFrame
    try {
      frame = JSON.parse(String(event.data)) as BridgeFrame
    } catch {
      return
    }
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
      case "theme-state": {
        this.emit("theme", frame)
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
