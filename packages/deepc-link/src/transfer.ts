/**
 * deepc-link 可靠传输共享工具（hash + base64 + 会话 id）。
 *
 * 两端通用实现，无运行时依赖；供工程同步的 sender/receiver 共用（自动分包底座）。
 * 校验采用 Web Crypto SHA-256；非安全上下文（subtle 缺失）时降级为空串，
 * 调用方跳过 hash 校验、仅保留 size 校验，优雅降级不影响传输。
 */

/** 高效 base64 编码（分块 String.fromCharCode，避免 O(n²) 拼接卡死大文件）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk)
    binary += String.fromCharCode.apply(null, Array.from(slice))
  }
  return btoa(binary)
}

/** base64 解码为字节（atob 一次展开，分块由调用方规避超大串）。 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * 拼接多个字节块为单个 Uint8Array。
 * 关键：分块传输时每块 base64 自带 padding，不能 join base64 字符串后整体 atob
 * （padding 出现在中部会 InvalidCharacterError），必须逐块解码后按字节拼接。
 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** SHA-256 十六进制（小写）；Web Crypto 不可用时返回空串（调用方降级跳过校验）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return ''
    // slice() 返回新分配 ArrayBuffer 的 view，规避 TS 泛型 TypedArray 的
    // ArrayBufferLike 与 BufferSource(ArrayBuffer) 不匹配。
    const digest = await subtle.digest('SHA-256', bytes.slice())
    const arr = new Uint8Array(digest)
    let hex = ''
    for (const b of arr) hex += b.toString(16).padStart(2, '0')
    return hex
  } catch {
    return ''
  }
}

/** 生成传输会话 id（16 hex，随机）。 */
export function createTxId(): string {
  const bytes = new Uint8Array(8)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}
