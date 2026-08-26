/**
 * remote-chrome —— 远端页面 chrome 装饰（仅远端生效，由 host-ui App 在 remoteMode 下调用）。
 *
 * 远端（非 127.0.0.1:3080 官方 origin：3081 鉴权代理 / 隧道域名）时：
 *   1) dsh 官方 sidebar 顶部品牌名 "DeepSeek" 替换为所连接设备名；
 *   2) 页面 title 动态改为 `DSH · {deviceName} · {connectTime}`（时长每秒刷新）；
 *   3) favicon 换成 deepSea logo（不依赖 dsh 官方图标）。
 *
 * 全部幂等 + DOM 缺失兜底（MutationObserver 等待 React 渲染出 sidebar）。
 */

import { DEEPSEA_LOGO } from '../deepsea-logo'
import { formatDuration } from './host-ui/api'
import type { BackendStatus } from './host-ui/types'

/** dsh sidebar 顶部品牌名容器（slot `sidebar.brand.name` 的外层）。 */
const BRAND_NAME_SLOT = '.hHd-Xa_brandName'
const BRAND_STYLE_ID = '__deepc_brand_style'
const FAVICON_ID = '__deepc_favicon'

let brandReplaced = false
let faviconInstalled = false
let titleTimer: number | null = null

const titleState = { deviceName: '', connectedAt: null as number | null }

/** 注入品牌名替换样式（幂等；宽高/字号对齐 dsh brandName 18px/600/24px）。 */
function ensureBrandStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(BRAND_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = BRAND_STYLE_ID
  // max-width 对齐原始 brandName（156px），超长 ellipsis 截断，不换行挤压 UI。
  style.textContent =
    '.__deepc_brandName{display:inline-block;max-width:156px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;font-weight:600;line-height:24px;color:inherit;letter-spacing:-.01em;vertical-align:middle;}'
  document.head.appendChild(style)
}

/** 替换 sidebar 顶部品牌名为设备名（等待 DOM 就绪，幂等）。 */
function replaceBrandName(deviceName: string): void {
  if (brandReplaced || typeof document === 'undefined') return
  const tryReplace = (): boolean => {
    const container = document.querySelector(BRAND_NAME_SLOT)
    if (!container) return false
    brandReplaced = true
    const span = document.createElement('span')
    span.className = '__deepc_brandName'
    span.textContent = deviceName
    container.replaceChildren(span)
    ensureBrandStyle()
    return true
  }
  if (tryReplace()) return
  const observer = new MutationObserver(() => {
    if (tryReplace()) observer.disconnect()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  window.setTimeout(() => observer.disconnect(), 10_000)
}

/** 替换 favicon 为 deepSea logo（主站同款；幂等）。 */
function installFavicon(): void {
  if (faviconInstalled || typeof document === 'undefined') return
  faviconInstalled = true
  const bytes = new TextEncoder().encode(DEEPSEA_LOGO)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const href = 'data:image/svg+xml;base64,' + btoa(bin)
  document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove())
  const link = document.createElement('link')
  link.id = FAVICON_ID
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = href
  document.head.appendChild(link)
}

/** 更新 title：`DSH · {deviceName} · {connectTime}`。 */
function updateTitle(): void {
  const { deviceName, connectedAt } = titleState
  const parts = ['DSH']
  if (deviceName) parts.push(deviceName)
  if (connectedAt != null) parts.push(formatDuration(Date.now() - connectedAt))
  document.title = parts.join(' · ')
}

/** 应用远端 chrome（幂等；deviceName 就绪后生效）。 */
export function applyRemoteChrome(status: BackendStatus): void {
  if (typeof document === 'undefined') return
  const name = status.deviceName || ''
  titleState.deviceName = name
  titleState.connectedAt = status.connectedAt ?? null
  if (name) replaceBrandName(name)
  installFavicon()
  if (titleTimer === null) {
    titleTimer = window.setInterval(updateTitle, 1000)
  }
  updateTitle()
}
