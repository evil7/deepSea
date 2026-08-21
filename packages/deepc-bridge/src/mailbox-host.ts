/**
 * deepc-bridge 插件端信箱 host —— 多端直连的被动应答端（登录后启动）。
 *
 * 登录后建立 WS 长连接（DO 信号房），被动接收「主站要连我」的 offer 推送 →
 * respondMailboxOffer 应答（answer 经 WS 回投）→ DC open → 安装数据面桥 + hello
 * 握手，使发起方（主站 chatUI）可远程操作本机 dsh。
 *
 * 多端直连无需任何码，同账号已登录设备可被主站点卡片直接连接。
 * 信令走 WS+DO 推送（无轮询）；同一 WS 连接顺带接收 config-changed 配置同步通知。
 */

import { respondMailboxOffer, type ClientSession } from './session'
import { createWsSignalClient } from './ws-signaling'
import { decodeEnvelope } from './node-signaling'
import { installApiBridge } from './api-bridge'
import { installHostHandshake } from './host-handshake'
import { HttpLocalApi } from './local-api'

export interface MailboxHostOptions {
  /** 本设备 nodeId。 */
  nodeId: string
  /** worker 服务基址（/ws/signal）。 */
  signalBase?: string
  /** 本地 dsh host 基址（127.0.0.1:3080）。 */
  hostBase?: string
  /** 收到 config-changed 推送时回调（配置同步拉增量用）。 */
  onConfigChanged?: () => void
}

export interface MailboxHost {
  /** 断开 WS + 关闭所有已建连接。 */
  stop: () => void
  /** 订阅「已建会话数变化」（多端直连连接/断开），返回取消函数。 */
  onSessionChange: (handler: (count: number) => void) => () => void
  /** 主动断开所有已建连接（插件端「断开」按钮）。 */
  disconnectAll: () => void
}

/**
 * 启动信箱 host（WS 长连接）。登录后调用；stop 时清理。
 * 每次成功建立 DC 即安装数据面桥 + hello 握手，连接断开自动回收。
 */
export function startMailboxHost(opts: MailboxHostOptions): MailboxHost {
  const signalBase = opts.signalBase ?? 'http://127.0.0.1:8787'
  const hostBase = opts.hostBase ?? 'http://127.0.0.1:3080'

  let running = true
  const sessions = new Set<ClientSession>()
  const sessionHandlers = new Set<(count: number) => void>()
  const wsClient = createWsSignalClient({ signalBase, nodeId: opts.nodeId })

  /** 通知「已建会话数变化」（0 = 无连接；>0 = 至少一台主站已连）。 */
  function notifySessionChange(): void {
    for (const h of sessionHandlers) h(sessions.size)
  }

  // WS 收到 config-changed 通知 → 透传回调（配置同步拉增量用）。
  if (opts.onConfigChanged) wsClient.onConfigChanged(opts.onConfigChanged)

  /** 装桥 + 握手。 */
  function installSession(session: ClientSession): void {
    const api = new HttpLocalApi(hostBase)
    const bridge = installApiBridge(session.dc, api)
    const handshake = installHostHandshake(session.dc, api)
    sessions.add(session)
    notifySessionChange()
    session.dc.addEventListener('close', () => {
      sessions.delete(session)
      bridge.dispose()
      handshake.dispose()
      notifySessionChange()
    })
  }

  // WS 收到 offer 推送 → 应答 + 回投 answer（WS）。
  wsClient.onSignal((_from, kind, payload) => {
    if (kind !== 'offer' || !running) return
    void (async () => {
      // payload 是 offer 信封（{from, v, sdp}），decode 取发起方 + 加密 SDP。
      const env = decodeEnvelope(payload)
      if (env === null) return
      const result = await respondMailboxOffer(opts.nodeId, env.from, env.sdp, {})
      if (result === null) return
      // 先投 answer，再等远端 DataChannel 打开（顺序不可反，否则死锁）。
      wsClient.send(result.answerTarget, 'answer', result.answerPayload)
      try {
        const session = await result.awaitSession()
        if (!running) {
          session.close()
          return
        }
        installSession(session)
      } catch {
        result.abort()
      }
    })()
  })

  // 启动：建立 WS 长连接（信令 + config-changed 通知共用此连接）。
  void wsClient.connect()

  return {
    stop: () => {
      running = false
      sessionHandlers.clear()
      wsClient.disconnect()
      for (const s of sessions) s.close()
      sessions.clear()
    },
    onSessionChange: (handler) => {
      sessionHandlers.add(handler)
      return () => {
        sessionHandlers.delete(handler)
      }
    },
    disconnectAll: () => {
      for (const s of sessions) {
        // 先发 deepc:bye 通知远端「主动断开」（远端据此不自动重连）。
        if (s.dc.readyState === 'open') {
          s.dc.send(JSON.stringify({ kind: 'control', cmd: 'deepc:bye', seq: 0, ts: Date.now() }))
        }
        s.close()
      }
      sessions.clear()
      notifySessionChange()
    },
  }
}
