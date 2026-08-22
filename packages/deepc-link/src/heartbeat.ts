/**
 * deepc-link 私有控制面探活（deepc:ping / deepc:pong）—— DataChannel 心跳。
 *
 * 定位：连接建立后，本地端（host，dsh node 端）作为主探活方，周期发送 `deepc:ping`；
 * 远端（client，chatUI）回 `deepc:pong`。任一端在回复超时后进入「互相探测」
 * 阶段（连发探针 ping，期待对端 pong），连续若干次无应答即判定连接失效，回调
 * onDead 触发两端状态自动变更（host 自动重建 offer，client 上报 disconnected）。
 *
 * 注意：本模块在 DataChannel 控制面私有通道上工作，与业务帧（unary/subscribe/sync
 * 等）互不干扰——调用方对 kind==='control' 的帧走 default 分支直接忽略。
 */

import type { ControlFrame } from './protocol'

export interface Heartbeat {
  stop: () => void
}

export interface HeartbeatCallbacks {
  /** 确认连接失效后回调（双端状态自动变更的入口）。 */
  onDead: () => void
}

export interface HeartbeatOptions {
  /** 主探活间隔（毫秒）。 */
  intervalMs?: number
  /** 无应答判定超时（毫秒）。 */
  timeoutMs?: number
  /** 互相探测阶段探针间隔（毫秒）。 */
  probeIntervalMs?: number
  /** 互相探测阶段探针次数。 */
  probeCount?: number
}

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_PROBE_INTERVAL_MS = 2_000
const DEFAULT_PROBE_COUNT = 3

/** host 端心跳：主动 ping，超时进入互相探测。 */
export function startHostHeartbeat(
  dc: RTCDataChannel,
  cb: HeartbeatCallbacks,
  opts: HeartbeatOptions = {}
): Heartbeat {
  return startHeartbeat(dc, 'host', cb, opts)
}

/** client 端心跳：被动回 pong + 监控 host 静默（互相探测）。 */
export function startClientHeartbeat(
  dc: RTCDataChannel,
  cb: HeartbeatCallbacks,
  opts: HeartbeatOptions = {}
): Heartbeat {
  return startHeartbeat(dc, 'client', cb, opts)
}

function startHeartbeat(
  dc: RTCDataChannel,
  role: 'host' | 'client',
  cb: HeartbeatCallbacks,
  opts: HeartbeatOptions
): Heartbeat {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const probeCount = opts.probeCount ?? DEFAULT_PROBE_COUNT

  let stopped = false
  let seq = 0
  let lastPeerActivity = Date.now()
  let probing = false
  let probeLeft = 0
  let probeTimer: ReturnType<typeof setInterval> | null = null

  function send(cmd: 'deepc:ping' | 'deepc:pong', s: number): void {
    if (stopped || dc.readyState !== 'open') return
    const frame: ControlFrame = { kind: 'control', cmd, seq: s, ts: Date.now() }
    try {
      dc.send(JSON.stringify(frame))
    } catch {
      // 通道已关闭，交由超时判定逻辑处理
    }
  }

  function stopProbing(): void {
    probing = false
    if (probeTimer !== null) {
      clearInterval(probeTimer)
      probeTimer = null
    }
  }

  /** 进入互相探测：立即连发 probeCount 个探针 ping，期待对端 pong。 */
  function startProbing(): void {
    if (probing || stopped) return
    probing = true
    probeLeft = probeCount
    send('deepc:ping', ++seq)
    probeLeft -= 1
    probeTimer = setInterval(() => {
      if (stopped) return
      if (Date.now() - lastPeerActivity <= timeoutMs) {
        // 探测期间收到对端活动 → 连接恢复
        stopProbing()
        return
      }
      if (probeLeft <= 0) {
        // 探针全部无应答 → 判定失效
        stopProbing()
        cb.onDead()
        return
      }
      send('deepc:ping', ++seq)
      probeLeft -= 1
    }, probeIntervalMs)
  }

  function onMessage(event: MessageEvent): void {
    let frame: ControlFrame
    try {
      frame = JSON.parse(event.data as string) as ControlFrame
    } catch {
      return
    }
    // 任何来自对端的帧（含 snapshot 业务帧）都视为「对端活动」，刷新探活基准。
    // 关键：快照传输期间 DC 上主要是 snapshot 帧，ping/pong 会因 SCTP buffer
    // 竞争而延迟/丢失；若只认 control 帧，会在传输高峰误判「对端静默」→
    // 双端 onDead → 连接震荡。业务帧本身即证明对端存活。
    lastPeerActivity = Date.now()
    if (frame.kind !== 'control') return
    if (frame.cmd === 'deepc:ping') {
      // 无论角色，收到 ping 即回 pong（互相探测的基础）
      send('deepc:pong', frame.seq)
    }
  }

  dc.addEventListener('message', onMessage)

  const pingTimer = setInterval(() => {
    if (stopped) return
    if (role === 'host') {
      // 主探活：host 周期发 ping（client 靠收到 ping 刷新 activity）
      send('deepc:ping', ++seq)
    }
    // 双端都做超时判定（client 无 host ping → 判定 host 静默）
    if (Date.now() - lastPeerActivity > timeoutMs) {
      startProbing()
    }
  }, intervalMs)

  return {
    stop() {
      stopped = true
      stopProbing()
      clearInterval(pingTimer)
      dc.removeEventListener('message', onMessage)
    },
  }
}
