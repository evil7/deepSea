/**
 * deepc-link 数据面桥（node 端）—— 接收 DataChannel 帧 → 调本地 API → 回传。
 *
 * 职责：绑定一条 DataChannel，处理远端 chatUI 发来的「操作互联」帧：
 *   · unary      → api.callUnary(method, payload) → 回传 unary-result
 *   · subscribe  → api.subscribe(stream) → 下行帧回传 downstream
 *   · unsubscribe → 取消订阅
 *
 * 控制帧（deepc:ping/pong）与工程同步帧（sync-*）不在此处理，由各自模块接管。
 * 本模块是 node 端「操作互联」的数据面入口，跑在 dsh host Node 进程内。
 */

import type {
  BridgeFrame,
  DownstreamFrame,
  ServerRequest,
  UnaryFrame,
  UnaryResultFrame,
} from './protocol'
import type { LocalApi } from './local-api'

/** 数据面桥句柄：绑定后负责收帧→调 API→回传，dispose 解除监听。 */
export interface ApiBridge {
  /** 解除 DataChannel 监听并关闭全部下行订阅。 */
  dispose: () => void
}

/**
 * 安装数据面桥：绑定 DataChannel 与本地 API 处理器。
 * 返回句柄；dispose 或 DC close 时自动清理。
 */
export function installApiBridge(dc: RTCDataChannel, api: LocalApi): ApiBridge {
  /** 活跃下行订阅：subId → 取消函数。 */
  const subs = new Map<string, () => void>()

  function send(frame: BridgeFrame): void {
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify(frame))
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

  function onMessage(event: MessageEvent): void {
    let frame: BridgeFrame
    try {
      frame = JSON.parse(String(event.data)) as BridgeFrame
    } catch {
      return
    }
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

  dc.addEventListener('message', onMessage)

  function dispose(): void {
    dc.removeEventListener('message', onMessage)
    for (const cancel of subs.values()) cancel()
    subs.clear()
  }
  dc.addEventListener('close', dispose, { once: true })

  return { dispose }
}
