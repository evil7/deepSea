// ---------------------------------------------------------------------------
// deepc-bridge 浏览器端密码学 —— 信箱信令密钥派生 + AES-GCM 加密。
// 与 packages/deepc-bridge/src/crypto.ts 严格对齐（信令是跨端契约）。
//
// 安全模型：
//   · nodeId → HKDF → AES-GCM 256 信箱信令密钥（收件人 nodeId 派生）
//   · SDP 经 AES-GCM 加密后入信箱，Worker 不见明文。
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** HKDF-SHA256 派生指定位数（nodeId 为 IKM）。 */
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
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode(info) },
    base,
    bits
  )
}

/**
 * nodeId → 信箱信令密钥（AES-GCM）。
 * 与 packages/deepc-bridge/src/crypto.ts 严格对齐（跨端契约）。
 * 收件人 nodeId 派生密钥：offer 用目标 nodeId、answer 用发起方 nodeId。
 */
export async function deriveNodeSignalKey(nodeId: string): Promise<CryptoKey> {
  const bits = await deriveBits(nodeId, "deepc-node", "sdp-encryption", 256)
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ])
}

/** AES-GCM 加密 → base64(iv + ciphertext)。 */
export async function encryptSignal(key: CryptoKey, plaintext: string): Promise<string> {
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
export async function decryptSignal(key: CryptoKey, encoded: string): Promise<string | null> {
  try {
    const buf = fromBase64(encoded)
    const iv = buf.slice(0, 12)
    const cipher = buf.slice(12)
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

function toBase64(buf: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
