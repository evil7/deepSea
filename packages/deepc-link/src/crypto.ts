/**
 * deepc-link 通用工具 —— 随机 ID 生成。
 *
 * 用途：
 *   · Device Grant 授权 state（一次性收件箱钥匙，host.ts 用）
 *
 * 注：旧 P2P 信箱信令的 HKDF/AES-GCM 加密（deriveNodeSignalKey 等）已随
 * 信令房（SignalRoom / /ws/api-link）一并退役删除。新架构（TOTP 2FA +
 * 匿名 Quick Tunnel）不再需要任何信令加密 —— 鉴权秘密是 TOTP secret，
 * 见 totp.ts。
 */

/**
 * 生成随机 UUID v4（122-bit 熵）。
 */
export function generateConnectId(): string {
  if (typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID()
    } catch {
      /* 部分非安全上下文会抛错，回退到手工生成。 */
    }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
