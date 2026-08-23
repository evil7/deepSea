/**
 * deepc-link 数据面桥（node 端）—— 接收 DataChannel 帧 → 调本地 API → 回传。
 *
 * 职责：绑定一条 DataChannel，处理远端 chatUI 发来的「多端互联」帧：
 *   · unary      → api.callUnary(method, payload) → 回传 unary-result
 *   · subscribe  → api.subscribe(stream) → 下行帧回传 downstream
 *   · unsubscribe → 取消订阅
 *
 * 控制帧（deepc:ping/pong）与工程同步帧（sync-*）不在此处理，由各自模块接管。
 * 本模块是 node 端「多端互联」的数据面入口，跑在 dsh host Node 进程内。
 */

import type {
  BridgeFrame,
  ChunkFrame,
  ChunkMetaFrame,
  DownstreamFrame,
  ServerRequest,
  UnaryFrame,
  UnaryResultFrame,
} from './protocol'
import type { LocalApi } from './local-api'
import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  createTxId,
  sha256Hex,
} from './transfer'

/** 数据面桥句柄：绑定后负责收帧→调 API→回传，dispose 解除监听。 */
export interface ApiBridge {
  /** 解除 DataChannel 监听并关闭全部下行订阅。 */
  dispose: () => void
}

/** 单帧超限阈值（JSON 文本长度）：超过则自动分包。SCTP 单消息实践 16KB 更稳。 */
const MAX_FRAME_BYTES = 16 * 1024

/**
 * 单个 chunk 的目标字节数。注意 chunk 的 data 经 base64 会膨胀 4/3，再套 JSON 包装；
 * 为保证 chunk 帧 JSON 总长 < 16KB（对齐 peerjs 的 chunkedMTU=16300，避开 Firefox→Chrome
 * 16384 截断），取 12000（base64 后 16000 + ~80 包装 ≈ 16080 < 16384）。
 */
const CHUNK_BYTES = 12000

/**
 * 安装数据面桥：绑定 DataChannel 与本地 API 处理器。
 * 返回句柄；dispose 或 DC close 时自动清理。
 */
export function installApiBridge(dc: RTCDataChannel, api: LocalApi): ApiBridge {
  /** 活跃下行订阅：subId → 取消函数。 */
  const subs = new Map<string, () => void>()

  /** 进行中的分块重组：txId → { total, chunks, sha256, slots, received, buf }。 */
  const reassembly = new Map<
    string,
    {
      total: number
      chunks: number
      sha256: string
      slots: (Uint8Array | null)[]
      received: number
    }
  >()

  /**
   * 发送一个桥接帧。若整帧超限则自动分包（chunk-meta + chunk×N），否则直发。
   * 【规避 SCTP 单消息超限崩溃】：session.history 等大 payload 的 unary-result /
   * 大 downstream 帧会超过 SCTP 消息上限导致 dsh fatal，故必须分包。
   */
  function send(frame: BridgeFrame): void {
    if (dc.readyState !== 'open') return
    const json = JSON.stringify(frame)
    if (json.length <= MAX_FRAME_BYTES) {
      dc.send(json)
      return
    }
    const bytes = new TextEncoder().encode(json)
    const txId = createTxId()
    const chunks = Math.ceil(bytes.length / CHUNK_BYTES)
    // sha256 依赖异步 subtle，无法在同步 send 内先算；SCTP 可靠有序已保证完整，
    // 故 meta.sha256 留空，对端按 total（size）兜底校验。
    const meta: ChunkMetaFrame = { kind: 'chunk-meta', txId, total: bytes.length, chunks, sha256: '' }
    dc.send(JSON.stringify(meta))
    for (let i = 0; i < chunks; i++) {
      const slice = bytes.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, bytes.length))
      const chunk: ChunkFrame = { kind: 'chunk', txId, index: i, data: bytesToBase64(slice) }
      dc.send(JSON.stringify(chunk))
    }
  }

  function handleUnary(frame: UnaryFrame): void {
    void api
      .callUnary(frame.method, frame.payload)
      .then((result): void => {
        const reply: UnaryResultFrame = {
          kind: 'unary-result',
          rpcId: frame.rpcId,
          result,
        }
        send(reply)
      })
  }

  function handleSubscribe(subId: string, stream: 'mux' | 'host'): void {
    if (subs.has(subId)) return
    const cancel = api.subscribe(stream, (env: ServerRequest) => {
      const frame: DownstreamFrame = {
        kind: 'downstream',
        subId,
        envelope: env,
      }
      send(frame)
    })
    subs.set(subId, cancel)
  }

  function handleUnsubscribe(subId: string): void {
    const cancel = subs.get(subId)
    if (cancel) {
      cancel()
      subs.delete(subId)
    }
  }

  /** 分发一个完整桥接帧到对应 handler。 */
  function handoff(frame: BridgeFrame): void {
    switch (frame.kind) {
      case 'unary':
        handleUnary(frame)
        break
      case 'subscribe':
        handleSubscribe(frame.subId, frame.stream)
        break
      case 'unsubscribe':
        handleUnsubscribe(frame.subId)
        break
      default:
        // control / sync-* 等帧由各自模块处理，此处忽略
        break
    }
  }

  /** 处理分块帧（chunk-meta / chunk）。返回 true 表示已被分包层消费。 */
  function handleChunk(
    frame: ChunkMetaFrame | ChunkFrame
  ): boolean {
    if (frame.kind === 'chunk-meta') {
      reassembly.set(frame.txId, {
        total: frame.total,
        chunks: frame.chunks,
        sha256: frame.sha256,
        slots: new Array(frame.chunks).fill(null),
        received: 0,
      })
      // 防串批：单 txId 一次最多 512 块（8MB+），超出即丢弃。
      if (frame.chunks > 512) reassembly.delete(frame.txId)
      return true
    }
    const re = reassembly.get(frame.txId)
    if (!re) return true
    if (frame.index < 0 || frame.index >= re.chunks) return true
    if (re.slots[frame.index]) return true // 重复块忽略
    re.slots[frame.index] = base64ToBytes(frame.data)
    re.received += 1
    if (re.received === re.chunks) {
      reassembly.delete(frame.txId)
      const parts: Uint8Array[] = []
      for (let i = 0; i < re.chunks; i++) {
        const p = re.slots[i]
        if (p) parts.push(p)
      }
      const bytes = concatBytes(parts)
      // sha256 校验（发送端 subtle 不可用时会用空串；空串则跳过校验，仅按 size 兜底）。
      if (re.sha256) {
        void sha256Hex(bytes).then((h) => {
          if (h === re.sha256) {
            const json = new TextDecoder().decode(bytes)
            try {
              handoff(JSON.parse(json) as BridgeFrame)
            } catch {
              /* 解析失败静默 */
            }
          }
        })
      } else if (bytes.length === re.total) {
        const json = new TextDecoder().decode(bytes)
        try {
          handoff(JSON.parse(json) as BridgeFrame)
        } catch {
          /* 解析失败静默 */
        }
      }
    }
    return true
  }

  function onMessage(event: MessageEvent): void {
    let frame: BridgeFrame
    try {
      frame = JSON.parse(String(event.data)) as BridgeFrame
    } catch {
      return
    }
    // 分包层优先：chunk-meta / chunk 帧由这里重组，重组完整后经 handoff 分发。
    if (frame.kind === 'chunk-meta' || frame.kind === 'chunk') {
      handleChunk(frame)
      return
    }
    handoff(frame)
  }

  dc.addEventListener('message', onMessage)

  function dispose(): void {
    dc.removeEventListener('message', onMessage)
    for (const cancel of subs.values()) cancel()
    subs.clear()
    reassembly.clear()
  }
  dc.addEventListener('close', dispose, { once: true })

  return { dispose }
}
