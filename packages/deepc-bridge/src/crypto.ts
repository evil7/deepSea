/**
 * deepc 配对码 + 密钥派生 + 信令加解密（浏览器端，Web Crypto API）。
 *
 * 安全模型（§8c Plan A 配对码派生）：
 *   · 配对码（6 位易读字符）经用户亲眼传递（QR/文本），不落盘、不走网络明文。
 *   · roomId = HKDF(配对码) → 32 字节 → 64 hex，作为 Worker KV 信令键；
 *     Worker 只见 roomId 哈希，不见配对码本身。
 *   · signalKey = HKDF(配对码) → AES-GCM 256，加密 SDP 信令；
 *     KV 只存密文，Worker 永不见 SDP 明文。
 */

const encoder = new TextEncoder()

/** 配对码字符集：排除易混淆字符（0/O、1/I/L）。 */
const PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** 生成一次性临时口令（默认 8 位，32^8 ≈ 1.1×10^12 组合）。 */
export function generatePairCode(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let code = ""
  for (let i = 0; i < len; i++) {
    code += PAIR_CODE_ALPHABET[bytes[i] % PAIR_CODE_ALPHABET.length]
  }
  return code
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

/** 配对码 → roomId（64 hex，KV 信令键）。 */
export async function deriveRoomId(pairingCode: string): Promise<string> {
  const bits = await deriveBits(pairingCode, "deepc-room", "room-id", 256)
  return bytesToHex(new Uint8Array(bits))
}

/** 配对码 → AES-GCM 信令密钥。 */
export async function deriveSignalKey(
  pairingCode: string
): Promise<CryptoKey> {
  const bits = await deriveBits(
    pairingCode,
    "deepc-signal",
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return hex
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
