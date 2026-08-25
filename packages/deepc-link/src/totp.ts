/**
 * deepc-link TOTP（RFC 6238）—— 本地 2FA 动态码。
 *
 * 用户用任意 2FA 应用（Google Authenticator / 1Password 等）扫码绑定 secret 后，
 * 每次访问输入 6 位动态码（30s 轮换）。secret 由插件本地生成并持久化（~/.deepc/），
 * 主站 Worker 只纳管 URL、不存任何 secret —— 最终安全由用户本地掌控。
 *
 * 校验：HMAC-SHA1 + RFC 6238 动态截断 → 6 位数字；±1 时间步容差（防时钟漂移）。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 生成随机 TOTP secret（默认 20 字节 → base32 32 字符）。 */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(new Uint8Array(randomBytes(bytes)))
}

/**
 * SHA-512 哈希（hex）—— 主站 bypass 的「远端存储散列」。
 * 单向散列：主站存 sha512(secret)，不泄露 secret 明文（20 字节 CSPRNG，彩虹表不可行），
 * TOTP 动态码本身仍由本地 secret 派生，安全边界不变。
 */
export function sha512Hex(input: string): string {
  return createHash('sha512').update(input).digest('hex')
}

/**
 * HMAC-SHA256（hex）—— 主站用 sha512(secret) 作密钥签一次性 ticket，插件验签。
 * 一次性 + 短 TTL + nodeId 绑定，防重放与跨节点伪造。
 */
export function hmacSha256Hex(key: string, msg: string): string {
  return createHmac('sha256', key).update(msg).digest('hex')
}

/** 字节 → base32（RFC 4648，无 padding）。 */
export function base32Encode(buf: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** base32 → 字节（容忍空格/连字符/小写/缺 padding）。 */
export function base32Decode(str: string): Uint8Array {
  const cleaned = str.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 计算某时间点的 TOTP 动态码（HMAC-SHA1 + RFC 6238 动态截断）。 */
export function totpCode(
  secret: string,
  time = Date.now(),
  stepSec = 30,
  digits = 6
): string {
  const counter = Math.floor(time / 1000 / stepSec)
  const key = base32Decode(secret)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter), 0)
  const hmac = createHmac('sha1', key).update(msg).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  const code = binary % 10 ** digits
  return code.toString().padStart(digits, '0')
}

/** 校验动态码（±window 步容差，常量时间比较）。 */
export function verifyTotp(
  secret: string,
  input: string,
  time = Date.now(),
  window = 1
): boolean {
  const cleaned = input.trim()
  if (!/^\d{6}$/.test(cleaned)) return false
  for (let w = -window; w <= window; w++) {
    if (constantEqual(totpCode(secret, time + w * 30_000), cleaned)) return true
  }
  return false
}

/** 生成 otpauth:// URI（供 2FA 应用扫码绑定）。 */
export function otpauthUri(
  secret: string,
  label: string,
  issuer = 'deepc-link'
): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?${params.toString()}`
}

/** 常量时间字符串比较（长度不同直接 false，防长度泄漏）。 */
function constantEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
