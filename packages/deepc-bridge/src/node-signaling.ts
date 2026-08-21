/**
 * deepc-bridge 信箱信封编解码 —— 多端直连信令的跨端契约（WS+DO 推送）。
 *
 * 信令走 /ws/signal（DO 信号房推送），本模块只做信封编解码（不接触明文 SDP）：
 *   · 寻址：nodeId
 *   · 信封：payload 为 JSON 信封 { from, v, sdp }，from = 发送方 nodeId（供 answer 回投）
 *
 * 加密在调用方（session.ts）用 deriveNodeSignalKey 完成，DO 只见密文。
 */

export type MailboxKind = "offer" | "answer"

/** 信令服务基址（本地 dev worker 8787，生产 deepc.cn）。 */
export const DEFAULT_SIGNAL_BASE = "http://127.0.0.1:8787"

/** 信箱信封（跨端契约）：sdp 已是 AES-GCM 密文（收件人 nodeId 派生密钥）。 */
export interface MailboxEnvelope {
  /** 发送方 nodeId（answer 回投地址）。 */
  from: string
  v: 1
  /** 加密后的 SDP。 */
  sdp: string
}

/** 编码信封 → JSON 字符串。 */
export function encodeEnvelope(from: string, sdp: string): string {
  const env: MailboxEnvelope = { from, v: 1, sdp }
  return JSON.stringify(env)
}

/** 解码信封（非法/缺失字段返回 null）。 */
export function decodeEnvelope(raw: string): MailboxEnvelope | null {
  try {
    const obj = JSON.parse(raw) as Partial<MailboxEnvelope>
    if (
      typeof obj.from !== "string" ||
      obj.from.length === 0 ||
      obj.v !== 1 ||
      typeof obj.sdp !== "string" ||
      obj.sdp.length === 0
    ) {
      return null
    }
    return { from: obj.from, v: 1, sdp: obj.sdp }
  } catch {
    return null
  }
}
