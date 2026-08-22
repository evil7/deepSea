// ---------------------------------------------------------------------------
// 设备指纹 —— 基于浏览器 + 设备特征生成稳定 driveId（UUID v4 格式）。
//
// 同一设备 + 同一浏览器配置 → 相同 driveId → 注册时 upsert（不会重复创建）。
// 特征来源：UA、平台、屏幕、时区、语言、硬件并发数、颜色深度等。
// 注意：清除浏览器数据会重置指纹（这是预期行为，等同于「新设备」）。
// ---------------------------------------------------------------------------

const DRIVE_ID_KEY = "deepsea:driveId"
const DRIVE_NAME_KEY = "deepsea:driveName"

/**
 * 收集浏览器 + 设备特征，生成稳定字符串。
 * 特征选择原则：
 *   · 同一设备同一浏览器配置下稳定（刷新、重开不变）
 *   · 不同设备大概率不同（硬件差异 → 屏幕/核心数/内存）
 */
async function collectFingerprint(): Promise<string> {
  const nav = navigator
  const scr = screen

  const parts = [
    nav.userAgent,
    nav.platform,
    nav.language,
    // 屏幕分辨率 + 色深（多显示器 / 远程桌面可区分）
    `${scr.width}x${scr.height}x${scr.colorDepth}`,
    // 时区
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    // 硬件并发（CPU 核心数，高稳定区分度）
    String(nav.hardwareConcurrency ?? 0),
    // 设备内存（GB，Chrome/Edge 支持，Safari/Firefox 返回 0）
    String((nav as Navigator & { deviceMemory?: number }).deviceMemory ?? 0),
    // 是否支持触控（桌面 vs 平板 vs 手机）
    String(nav.maxTouchPoints ?? 0),
  ]

  const raw = parts.join("|||")
  const encoded = new TextEncoder().encode(raw)
  const hash = await crypto.subtle.digest("SHA-256", encoded)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * SHA-256 hex → UUID v4 格式（8-4-4-4-12）。
 * 取前 32 hex 字符，插入分隔符 + 版本/变体位。
 */
function hexToUuid(hex: string): string {
  const h = hex.slice(0, 32)
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    // 第 13 位设为 4（UUID v4）
    "4" + h.slice(13, 16),
    // 第 17 位设为 8/9/a/b（变体 1）
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-")
}

/** 从 UA 提取可读的浏览器 + 平台名。 */
function deriveReadableName(): string {
  const ua = navigator.userAgent

  // 浏览器名
  let browser = "Browser"
  if (ua.includes("Edg/")) browser = "Edge"
  else if (ua.includes("OPR/") || ua.includes("Opera")) browser = "Opera"
  else if (ua.includes("Chrome/") && !ua.includes("Edg/")) browser = "Chrome"
  else if (ua.includes("Firefox/")) browser = "Firefox"
  else if (ua.includes("Safari/") && !ua.includes("Chrome")) browser = "Safari"

  // 平台
  let platform = "Desktop"
  const p = navigator.platform?.toLowerCase() ?? ""
  if (p.includes("win")) platform = "Windows"
  else if (p.includes("mac")) platform = "macOS"
  else if (p.includes("linux")) platform = "Linux"
  else if (/android/i.test(ua)) platform = "Android"
  else if (/iphone|ipad|ipod/i.test(ua)) platform = "iOS"

  return `${browser}-${platform}`
}

/**
 * 获取或生成设备 driveId + 名称（localStorage 持久化）。
 * 返回 { driveId: "xxxxxxxx-xxxx-4xxx-...", driveName: "Chrome-Windows" }。
 */
export async function getOrCreateDrive(): Promise<{
  driveId: string
  driveName: string
}> {
  try {
    const existingId = localStorage.getItem(DRIVE_ID_KEY)
    const existingName = localStorage.getItem(DRIVE_NAME_KEY)
    if (existingId && existingName) {
      return { driveId: existingId, driveName: existingName }
    }
  } catch {
    // localStorage 不可用，降级为每次生成
  }

  const hex = await collectFingerprint()
  const driveId = hexToUuid(hex)
  const driveName = deriveReadableName()

  try {
    localStorage.setItem(DRIVE_ID_KEY, driveId)
    localStorage.setItem(DRIVE_NAME_KEY, driveName)
  } catch {
    // 忽略
  }

  return { driveId, driveName }
}
