/**
 * host-ui 后端调用与工具函数（与 node 端 totp.ts 同算法，仅浏览器展示用）。
 */

import { toString as qrToSvg } from 'qrcode'
import { DEEPC_CTRL_BASE } from './constants'

/** base32 → 字节（浏览器端，与 node 端 totp.ts 同算法，仅用于展示动态码）。 */
export function base32Decode(str: string): Uint8Array<ArrayBuffer> {
  const cleaned = str.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch)
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

/** 浏览器端 TOTP 动态码（RFC 6238 HMAC-SHA1，Web Crypto；仅用于悬浮球展示）。 */
export async function browserTotpCode(secret: string, time = Date.now()): Promise<string> {
  const counter = Math.floor(time / 1000 / 30)
  const key = base32Decode(secret)
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg))
  const offset = sig[sig.length - 1] & 0x0f
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff)
  const code = binary % 1_000_000
  return code.toString().padStart(6, '0')
}

/** 调用插件后端控制端点。remote=true 声明远端上下文（后端据此裁剪敏感字段，不下发 TOTP secret）。 */
export async function deepcCall<T>(action: string, body?: unknown, remote = false): Promise<T | null> {
  try {
    const res = await fetch(`${DEEPC_CTRL_BASE}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote ? { 'X-Deepc-Remote': '1' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * 生成 TOTP otpauth URI 的二维码（data URL）。
 *
 * 用 `qrcode` npm 组件在浏览器本地生成 SVG（绝不调用第三方二维码服务，避免把含
 * TOTP secret 的 otpauth URI 外泄）。svg-tag renderer 纯字符串拼装，无 Buffer/fs
 * 依赖，esbuild browser 打包走 lib/browser.js（browser field 映射）。
 */
export async function qrDataUrl(otpauthUri: string): Promise<string> {
  try {
    const svg = await qrToSvg(otpauthUri, {
      type: 'svg',
      // 静区（quiet zone）提至 4 模块宽（二维码标准要求 ≥4，扫描器据此定位边界）；
      // 用 scale（每模块像素）而非 width 生成，避免 width 推导出小数 scale 导致模块模糊密集；
      // 明确黑白两色，保证对比度。
      margin: 4,
      scale: 8,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
    const bytes = new TextEncoder().encode(svg)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return 'data:image/svg+xml;base64,' + btoa(bin)
  } catch {
    return ''
  }
}

/** 隧道 URL 的二级域名前缀（去 https:// 协议与路径）。 */
export function prettyHost(url: string | null): string {
  if (!url) return ''
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

/** 隧道 URL 的最前段（标识字段），如 surround-magnetic-belly-intelligent。 */
export function prettySubdomain(url: string | null): string {
  if (!url) return ''
  return prettyHost(url).split('.')[0] || ''
}

/** 连接时长格式化（MM:SS，超 1 小时 HH:MM:SS）。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 复制到剪贴板（纯复制，无 UI 反馈；反馈由组件 state 承担）。 */
export async function copyToClipboard(text: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    /* 剪贴板不可用静默忽略 */
  }
}

/** TOTP secret 分组（每 4 字符一组，供组件逐组渲染）。 */
export function secretGroups(secret: string): string[] {
  return secret.replace(/\s/g, '').match(/.{1,4}/g) ?? []
}
