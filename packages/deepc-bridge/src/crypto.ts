/**
 * deepc 密钥派生 + 信令加解密（浏览器端，Web Crypto API）。
 *
 * 安全模型（信箱式信令）：
 *   · nodeId → HKDF → AES-GCM 256 信箱信令密钥（收件人 nodeId 派生）；
 *     SDP 经 AES-GCM 加密后入信箱，Worker 只存密文，不见明文。
 */

const encoder = new TextEncoder()

/**
 * 生成随机 UUID v4（122-bit 熵）。
 * 用于 nodeId（设备标识）与 Device Grant 授权 state（一次性收件箱钥匙）。
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

/** HKDF-SHA256 派生指定位数（配对码为 IKM）。 */
async function deriveBits(
  ikm: string,
  salt: string,
  info: string,
  bits: number
): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ikm),
    "HKDF",
    false,
    ["deriveBits"]
  )
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      info: encoder.encode(info),
    },
    base,
    bits
  )
}

/**
 * nodeId → 信箱信令密钥（AES-GCM）。
 * 多端直连（信箱式信令）：收件人 nodeId 派生密钥——offer 用目标设备 nodeId 密钥，
 * answer 用发起方 nodeId 密钥，两端各自「收件箱密钥」独立。nodeId 登录态私有
 * （同账号设备 list 可见），v1 简化安全边界足够。
 */
export async function deriveNodeSignalKey(
  nodeId: string
): Promise<CryptoKey> {
  const bits = await deriveBits(
    nodeId,
    "deepc-node",
    "sdp-encryption",
    256
  )
  return crypto.subtle.importKey(
    "raw",
    bits,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  )
}

/** AES-GCM 加密 → base64(iv + ciphertext)。 */
export async function encryptSignal(
  key: CryptoKey,
  plaintext: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  )
  const buf = new Uint8Array(iv.length + cipher.byteLength)
  buf.set(iv, 0)
  buf.set(new Uint8Array(cipher), iv.length)
  return toBase64(buf)
}

/** base64(iv + ciphertext) → 解密明文（失败返回 null）。 */
export async function decryptSignal(
  key: CryptoKey,
  encoded: string
): Promise<string | null> {
  try {
    const buf = fromBase64(encoded)
    const iv = buf.slice(0, 12)
    const cipher = buf.slice(12)
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipher
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
