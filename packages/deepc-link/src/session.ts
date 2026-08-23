/**
 * deepc-link 会话编排 —— WebRTC 连接建立（多端直连底座）。
 *
 * 信令走 WS+DO（/ws/api-link 信号房）：offer/answer 由 DO 推送，两端用
 * deriveNodeSignalKey 派生的 AES-GCM 密钥加密 SDP，DO 只见密文。
 *
 * 信令采用非 trickle ICE：等 ICE gathering complete 后一次性传完整 SDP。
 */

import {
  decryptSignal,
  deriveNodeSignalKey,
  encryptSignal,
} from './crypto'
import { encodeEnvelope } from './node-signaling'

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

export interface ClientSession {
  dc: RTCDataChannel
  pc: RTCPeerConnection
  close: () => void
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

// ---------------------------------------------------------------------------
// 多端直连信令（WS+DO）—— nodeId 寻址 + 收件人 nodeId 派生密钥
//
// offer/answer 经 /ws/api-link（DO 信号房）推送，两端用 deriveNodeSignalKey
// 派生的 AES-GCM 密钥加密 SDP（DO 只见密文）。信箱式 HTTP 轮询已移除（A2）。
// ---------------------------------------------------------------------------

/** 信箱 offer 应答产物：answer（目标 nodeId + 加密信封）+ 延迟建会话。 */
export interface MailboxAnswer {
  /** answer 回投目标（发起方 nodeId）。 */
  answerTarget: string
  /** encodeEnvelope 后的 answer 信封（已 AES-GCM 加密，收件人 = 发起方 nodeId）。 */
  answerPayload: string
  /** 投递 answer 后调用：等远端 DataChannel 打开，返回已建会话（超时 reject）。 */
  awaitSession: () => Promise<ClientSession>
  /** 放弃应答（投递失败等场景），关闭本地 PC。 */
  abort: () => void
}

/**
 * 响应方核心：给定「发起方 nodeId + 加密 offer SDP」，解密 → createAnswer →
 * 加密 answer → 返回待投递 answer + 延迟建会话（mailbox-host 的 WS 监听调用）。
 */
export async function respondMailboxOffer(
  selfNodeId: string,
  fromNodeId: string,
  offerCipher: string,
  opts: SessionOptions = {}
): Promise<MailboxAnswer | null> {
  try {
    const key = await deriveNodeSignalKey(selfNodeId)
    const offerSdp = await decryptSignal(key, offerCipher)
    if (offerSdp === null) return null

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    // 关键：在 setRemoteDescription(offer) 之前监听 datachannel。
    const dcPromise = waitRemoteDataChannel(pc, opts.openTimeoutMs)

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await waitIceComplete(pc)

    const answerKey = await deriveNodeSignalKey(fromNodeId)
    const answerSdp = pc.localDescription?.sdp ?? ''
    const cipher = await encryptSignal(answerKey, answerSdp)
    const answerEnvelope = encodeEnvelope(selfNodeId, cipher)

    // 注意：不能在此 await dcPromise —— answer 必须先投递给发起方，发起方
    // setRemoteDescription(answer) 后 DataChannel 才可能 open。此处 await 会形成
    // 「等 dc open 才投 answer / 投 answer 才 dc open」的死锁。故把等待延迟到
    // awaitSession（调用方先投 answer，再 await）。
    const abort = (): void => {
      pc.close()
    }
    return {
      answerTarget: fromNodeId,
      answerPayload: answerEnvelope,
      awaitSession: async () => {
        const dc = await dcPromise
        return {
          dc,
          pc,
          close: () => {
            dc.close()
            pc.close()
          },
        }
      },
      abort,
    }
  } catch {
    return null
  }
}
