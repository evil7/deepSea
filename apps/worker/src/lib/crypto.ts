// ---------------------------------------------------------------------------
// GitHub token 加密缓存（AES-GCM，密钥派生自 TOKEN_ENC_KEY）
//   避免把明文 token 落 KV；解密仅在需要以用户身份调 GitHub API 时进行。
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** 由任意长随机串派生 AES-GCM 密钥（HKDF-SHA256） */
export async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("deepsea-oauth-kv"),
      info: encoder.encode("token-encryption"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

/** AES-GCM 加密 → base64(iv + ciphertext) */
export async function encryptToken(
  secret: string,
  token: string
): Promise<string> {
  const key = await deriveAesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(token)
  )
  const buf = new Uint8Array(iv.length + cipher.byteLength)
  buf.set(iv, 0)
  buf.set(new Uint8Array(cipher), iv.length)
  return toBase64(buf)
}

/** base64(iv + ciphertext) → 解密明文（失败返回 null） */
export async function decryptToken(
  secret: string,
  encoded: string
): Promise<string | null> {
  try {
    const key = await deriveAesKey(secret)
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
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
