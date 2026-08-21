// ---------------------------------------------------------------------------
// deepc-bridge 浏览器端客户端（主站 chatUI 连接本地 dsh 的入口）。
//
// 职责：
//   · connect(pairCode)：凭临时口令经 Worker 信令建立 WebRTC DataChannel
//   · call(method, payload)：unary 调用本地 dsh API，返回 RpcResult
//   · subscribe(stream, handler)：订阅下行事件流（events.mux / events.host）
//   · on(event, handler)：连接状态 / hello / downstream 事件分发
//
// 帧协议与 packages/deepc-bridge 严格对齐；信令走 Worker /auth/signal/*。
// ---------------------------------------------------------------------------

import {
  decryptSignal,
  deriveRoomId,
  deriveSignalKey,
  encryptSignal,
} from "./crypto"
import { pollSignalDetailed, putSignal } from "./signaling"
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

export class DeepcClient {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private _state: ClientState = "idle"

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

  /** 凭配对码连接本地 dsh host。 */
  async connect(pairCode: string, signalBase?: string): Promise<void> {
    this.setState("connecting")
    const roomId = await deriveRoomId(pairCode)
    const signalKey = await deriveSignalKey(pairCode)

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc

    try {
      // 关键：在 setRemoteDescription(offer) 之前监听 datachannel（时序见 session.ts）。
      const dcPromise = this.waitRemoteDataChannel(pc)

      const outcome = await pollSignalDetailed(roomId, "offer", {
        baseUrl: signalBase,
        timeoutMs: 60_000,
      })
      if (outcome.status === "rate-limited") {
        pc.close()
        this.setState("error")
        this.emit("error", `连接过于频繁，请 ${outcome.retryAfter ?? 60}s 后再试`)
        return
      }
      if (outcome.status !== "ok") {
        pc.close()
        this.setState("error")
        this.emit("error", "配对失败：口令错误或已过期")
        return
      }
      const offerSdp = await decryptSignal(signalKey, outcome.payload)
      if (offerSdp === null) {
        pc.close()
        this.setState("error")
        this.emit("error", "配对失败：信令解密失败")
        return
      }

      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await this.waitIceComplete(pc)

      const answerSdp = pc.localDescription?.sdp ?? ""
      const answerCipher = await encryptSignal(signalKey, answerSdp)
      await putSignal(roomId, "answer", answerCipher, signalBase)

      const dc = await dcPromise
      this.dc = dc
      dc.addEventListener("message", (ev) => this.onMessage(ev))
      dc.addEventListener("close", () => {
        this.dispose()
        this.setState("disconnected")
      })

      this.setState("connected")
      // 握手确认：回应 node 端 hello。
      this.send({ kind: "hello-ack", protocolVersion: PROTOCOL_VERSION } as BridgeFrame)
    } catch {
      pc.close()
      this.setState("error")
      this.emit("error", "连接超时")
    }
  }

  /** 断开连接。 */
  disconnect(): void {
    this.dispose()
    this.setState("disconnected")
  }

  private dispose(): void {
    for (const p of this.unaryPending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: { code: "disconnected", message: "连接已断开" } })
    }
    this.unaryPending.clear()
    this.subHandlers.clear()
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

  private waitRemoteDataChannel(pc: RTCPeerConnection): Promise<RTCDataChannel> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("datachannel timeout")), 10_000)
      const onDatachannel = (event: RTCDataChannelEvent): void => {
        const dc = event.channel
        const check = (): void => {
          if (dc.readyState === "open") {
            clearTimeout(timer)
            dc.removeEventListener("open", check)
            pc.removeEventListener("datachannel", onDatachannel)
            resolve(dc)
          }
        }
        dc.addEventListener("open", check)
        check()
      }
      pc.addEventListener("datachannel", onDatachannel)
    })
  }
}

/** 单例（应用内共享一条连接）。 */
export const deepcClient = new DeepcClient()
