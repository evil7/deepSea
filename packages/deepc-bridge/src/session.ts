/**
 * deepc-bridge 会话编排 —— 配对 + 信令 + WebRTC 连接建立（deepc-sonar-bridge 底座）。
 *
 * 两端分工：
 *   · Host（本地 dsh node 端）：生成配对码 → 建 PeerConnection + DataChannel
 *     → offer → 加密入信令 → 轮询 answer → DC open。
 *   · Client（远端 chatUI）：输入配对码 → 轮询 offer → answer → 加密入信令
 *     → DC open。
 *
 * 信令采用非 trickle ICE：等 ICE gathering complete 后一次性传完整 SDP。
 */

import {
  decryptSignal,
  deriveRoomId,
  deriveSignalKey,
  encryptSignal,
  generatePairCode,
} from './crypto'
import { pollSignal, pollSignalDetailed, putSignal } from './signaling'

/**
 * 公共 STUN 服务器（真实免费服务，生产跨设备 NAT 穿透）。
 * 多源冗余：任一 STUN 可达即能拿到 srflx 候选；本地 loopback 时 STUN 候选
 * 可能失败，但 host（mDNS .local）候选仍可直连，不影响本地同机测试。
 */
const ICE_SERVERS: RTCConfiguration['iceServers'] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

export interface SessionOptions {
  /** 信令服务基址（默认 deepc.cn）。 */
  signalBase?: string
  /** 轮询超时（毫秒）。 */
  signalTimeoutMs?: number
  /** DataChannel 打开超时（毫秒）。 */
  openTimeoutMs?: number
}

export interface HostSession {
  pairCode: string
  dc: RTCDataChannel
  pc: RTCPeerConnection
  /** 关闭连接。 */
  close: () => void
}

/** node 端 offer 阶段产物（配对码已生成，offer 已入信令，等待远端）。 */
export interface HostOffer {
  pairCode: string
  roomId: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
}

export interface ClientSession {
  dc: RTCDataChannel
  pc: RTCPeerConnection
  close: () => void
}

/**
 * host 阶段 1：生成配对码 → 建 PC+DC → offer → 加密入信令。
 * 传入 pairCodeOverride 可复用已有连接码（刷新后自动恢复用同一码重建 offer）。
 */
export async function createHostOffer(
  opts: SessionOptions = {},
  pairCodeOverride?: string
): Promise<HostOffer | null> {
  const pairCode = pairCodeOverride ?? generatePairCode()
  const roomId = await deriveRoomId(pairCode)
  const signalKey = await deriveSignalKey(pairCode)

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const dc = pc.createDataChannel('deepc', { ordered: true })

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitIceComplete(pc)

    const offerSdp = pc.localDescription?.sdp ?? ''
    const offerCipher = await encryptSignal(signalKey, offerSdp)
    if (!(await putSignal(roomId, 'offer', offerCipher, opts.signalBase))) {
      pc.close()
      return null
    }
    return { pairCode, roomId, pc, dc }
  } catch {
    pc.close()
    return null
  }
}

/** host 阶段 2：轮询 answer → setRemoteDescription → 等 DC open → 安装 relay。 */
export async function finalizeHost(
  offer: HostOffer,
  opts: SessionOptions = {}
): Promise<HostSession | null> {
  const signalKey = await deriveSignalKey(offer.pairCode)
  try {
    const answerCipher = await pollSignal(offer.roomId, 'answer', {
      baseUrl: opts.signalBase,
      timeoutMs: opts.signalTimeoutMs ?? 60_000,
    })
    if (answerCipher === null) {
      offer.pc.close()
      return null
    }
    const answerSdp = await decryptSignal(signalKey, answerCipher)
    if (answerSdp === null) {
      offer.pc.close()
      return null
    }
    await offer.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    await waitDataChannelOpen(offer.dc, opts.openTimeoutMs)

    return {
      pairCode: offer.pairCode,
      dc: offer.dc,
      pc: offer.pc,
      close: () => {
        offer.dc.close()
        offer.pc.close()
      },
    }
  } catch {
    offer.pc.close()
    return null
  }
}

/** host 便捷组合：一次跑完两阶段（适用于无需中途展示配对码的场景）。 */
export async function startHostSession(
  opts: SessionOptions = {}
): Promise<HostSession | null> {
  const offer = await createHostOffer(opts)
  if (offer === null) return null
  return finalizeHost(offer, opts)
}

/** client 端配对失败原因（供前端提示）。 */
export type ClientSessionError =
  | "rate-limited" // 错误限流封禁
  | "timeout" // 口令错误/超时
  | "open-timeout" // DataChannel 打开超时

/** client 端配对结果（含错误详情，供 inject.ts 上报给 /sonar）。 */
export interface ClientSessionOutcome {
  session: ClientSession | null
  error?: ClientSessionError
  retryAfter?: number
  remainingAttempts?: number
}

/** client 端：凭临时口令建立连接并安装远端桥（返回详细结果）。 */
export async function startClientSessionDetailed(
  pairCode: string,
  opts: SessionOptions = {}
): Promise<ClientSessionOutcome> {
  const roomId = await deriveRoomId(pairCode)
  const signalKey = await deriveSignalKey(pairCode)

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

  try {
    // 关键：必须在 setRemoteDescription(offer) 之前监听 datachannel。远端
    // （node 端 createDataChannel）的 datachannel 事件可能在后续 await 间隙
    // 派发，若 handler 赋值过晚事件会丢失 → waitRemoteDataChannel 超时失败。
    const dcPromise = waitRemoteDataChannel(pc, opts.openTimeoutMs)

    const outcome = await pollSignalDetailed(roomId, 'offer', {
      baseUrl: opts.signalBase,
      timeoutMs: opts.signalTimeoutMs ?? 60_000,
    })
    if (outcome.status === 'rate-limited') {
      pc.close()
      return { session: null, error: 'rate-limited', retryAfter: outcome.retryAfter }
    }
    if (outcome.status !== 'ok') {
      pc.close()
      return {
        session: null,
        error: 'timeout',
        remainingAttempts: outcome.remainingAttempts,
      }
    }
    const offerSdp = await decryptSignal(signalKey, outcome.payload)
    if (offerSdp === null) {
      pc.close()
      return { session: null, error: 'timeout' }
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await waitIceComplete(pc)

    const answerSdp = pc.localDescription?.sdp ?? ''
    const answerCipher = await encryptSignal(signalKey, answerSdp)
    if (!(await putSignal(roomId, 'answer', answerCipher, opts.signalBase))) {
      pc.close()
      return { session: null, error: 'timeout' }
    }

    const dc = await dcPromise
    // 注意：不在此安装远端桥——操作互联的 chatUI 侧由调用方（主站 chatUI）负责
    // 创建 WebRtcApiClient 并 attach 到 dc，避免重复监听。
    return {
      session: {
        dc,
        pc,
        close: () => {
          dc.close()
          pc.close()
        },
      },
    }
  } catch {
    pc.close()
    return { session: null, error: 'open-timeout' }
  }
}

/** client 端：凭配对码建立连接并安装远端桥（兼容旧签名，返回 session 或 null）。 */
export async function startClientSession(
  pairCode: string,
  opts: SessionOptions = {}
): Promise<ClientSession | null> {
  const outcome = await startClientSessionDetailed(pairCode, opts)
  return outcome.session
}

/** 等待 ICE gathering complete（非 trickle，拿到完整 SDP）。 */
async function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onState)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onState)
  })
}

/** 等待本地创建的 DataChannel 打开。 */
function waitDataChannelOpen(
  dc: RTCDataChannel,
  timeoutMs?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('data channel open timeout')),
      timeoutMs ?? 10_000
    )
    const check = () => {
      if (dc.readyState === 'open') {
        clearTimeout(timer)
        dc.removeEventListener('open', check)
        resolve()
      }
    }
    dc.addEventListener('open', check)
    check()
  })
}

/** 等待远端建立的 DataChannel（datachannel 事件）打开。 */
function waitRemoteDataChannel(
  pc: RTCPeerConnection,
  timeoutMs?: number
): Promise<RTCDataChannel> {
  return new Promise((resolve, reject) => {
    const onDatachannel = (event: RTCDataChannelEvent): void => {
      const dc = event.channel
      const check = (): void => {
        if (dc.readyState === 'open') {
          clearTimeout(timer)
          dc.removeEventListener('open', check)
          pc.removeEventListener('datachannel', onDatachannel)
          resolve(dc)
        }
      }
      dc.addEventListener('open', check)
      check()
    }
    const timer = setTimeout(() => {
      pc.removeEventListener('datachannel', onDatachannel)
      reject(new Error('data channel open timeout'))
    }, timeoutMs ?? 10_000)
    pc.addEventListener('datachannel', onDatachannel)
  })
}
