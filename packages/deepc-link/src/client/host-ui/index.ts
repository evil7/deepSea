/**
 * host-ui 入口 —— deepSea 悬浮球 + Sheet（React 版，模块化）。
 *
 * 用 react-dom/client 的 createRoot 挂载（react-dom 由 dsh 前端 seed 提供，见 build.mjs external）。
 * 动画保留 animejs（操作 DOM style，与 React 渲染共存：React 只管内容，动画管容器 visibility/opacity/transform）。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { animate } from 'animejs'

import { deepcCall, prettySubdomain, copyToClipboard } from './api'
import { HOST_ZONE_ID, HOST_UI_STYLE_ID, SHEET_ID, TRIGGER_ID, isLoopbackHost, isRemoteContext } from './constants'
import { HOST_UI_CSS } from './styles'
import { DEEPSEA_LOGO, QR_ICON, USER_ICON } from './icons'
import { Avatar, Fab, Icon, TierRow } from './components'
import { useConnectedDuration, useQrDataUrl, useTotpCode } from './hooks'
import type { BackendStatus, HostUi, LinkMode } from './types'

const h = React.createElement

const INITIAL_STATUS: BackendStatus = {
  mode: 'local',
  loggedIn: false,
  deviceName: '',
  connected: false,
  url: null,
  localUrl: null,
  localOn: true,
  totpSecret: null,
  otpauthUri: null,
}

/** 隧道状态机 → 副文案。 */
function tunnelSubText(status: BackendStatus): { text: string; url: string | null } {
  const st = status.tunnelState ?? 'off'
  switch (st) {
    case 'off':
      return { text: '通过 Cloudflare 暴露到公网', url: null }
    case 'download-pending':
      return { text: 'cloudflared 待下载', url: null }
    case 'downloading':
      return { text: 'cloudflared 下载中…', url: null }
    case 'downloaded':
      return { text: 'cloudflared 已下载', url: null }
    case 'starting':
      return { text: '隧道连接中…', url: null }
    case 'running':
    case 'managed': {
      const label = st === 'managed' ? '已纳管' : '已启动'
      return status.url
        ? { text: `${label} · ${prettySubdomain(status.url)}`, url: status.url }
        : { text: label, url: null }
    }
    default:
      return { text: '隧道连接中…', url: null }
  }
}

/** 头部（品牌 + 登录/用户）。 */
function Head({
  status,
  onLogin,
  onLogout,
}: {
  status: BackendStatus
  onLogin: () => void
  onLogout: () => void
}): React.ReactElement {
  const p = status.profile
  const brand = h(
    'div',
    { className: 'dcb-brand' },
    h(Icon, { svg: DEEPSEA_LOGO }),
    h(
      'div',
      null,
      h('div', { className: 'dcb-brand-title' }, 'deepSea'),
      h('div', { className: 'dcb-brand-sub' }, '远端互联'),
    ),
  )
  if (status.loggedIn && p) {
    const name = p.name?.trim() || p.login
    return h(
      'div',
      { className: 'dcb-head' },
      brand,
      h(
        'div',
        { className: 'dcb-head-right' },
        h(
          'div',
          { className: 'dcb-head-user', title: '点击登出', onClick: onLogout },
          h(Avatar, { login: p.login, avatarUrl: p.avatar_url }),
          h('span', { className: 'dcb-user-name' }, name),
        ),
      ),
    )
  }
  return h(
    'div',
    { className: 'dcb-head' },
    brand,
    h(
      'div',
      { className: 'dcb-head-right' },
      h('button', {
        className: 'dcb-head-login',
        title: '登录主站',
        onClick: onLogin,
        dangerouslySetInnerHTML: { __html: USER_ICON },
      }),
    ),
  )
}

/** 2FA 动态码面板。 */
function OtpPanel({
  status,
  onShowQr,
}: {
  status: BackendStatus
  onShowQr: () => void
}): React.ReactElement {
  const { code, remainSec, expiring, progress } = useTotpCode(status.totpSecret)
  return h(
    'div',
    { className: 'dcb-card dcb-otp' },
    h(
      'div',
      { className: 'dcb-otp-head' },
      h(
        'span',
        { className: 'dcb-otp-label dcb-otp-label-row' },
        '2FA 安全码',
        h('button', {
          className: 'dcb-otp-qr-trigger',
          title: '显示二维码绑定',
          onClick: onShowQr,
          dangerouslySetInnerHTML: { __html: QR_ICON },
        }),
      ),
      h('span', { className: 'dcb-totp-remain', style: expiring ? { color: 'var(--dc-danger)' } : undefined }, `${remainSec}s`),
    ),
    h(
      'div',
      { className: 'dcb-otp-code' },
      ...code.replace(/\s/g, '').split('').map((c, i) => h('span', { key: i, className: 'dcb-otp-digit' }, c)),
    ),
    h(
      'div',
      { className: 'dcb-otp-count' },
      h('span', {
        className: 'dcb-totp-bar',
        style: { width: `${progress}%`, background: expiring ? 'var(--dc-danger)' : undefined },
      }),
    ),
  )
}

/** 二维码绑定面板。 */
function QrPanel({
  status,
  onClose,
  onRotate,
}: {
  status: BackendStatus
  onClose: () => void
  onRotate: () => void
}): React.ReactElement {
  const qrUrl = useQrDataUrl(status.otpauthUri)
  return h(
    'div',
    { className: 'dcb-card dcb-qr-panel' },
    h(
      'div',
      { className: 'dcb-otp-head' },
      h('span', { className: 'dcb-otp-label' }, '绑定 2FA'),
      h('button', { className: 'dcb-qr-close', onClick: onClose }, '×'),
    ),
    h(
      'div',
      { className: 'dcb-qr-deck' },
      h(
        'div',
        { className: 'dcb-qr-card dcb-qr-card--front' },
        qrUrl
          ? h('img', { className: 'dcb-qr', alt: '2FA 二维码', src: qrUrl })
          : null,
      ),
      h(
        'div',
        { className: 'dcb-qr-card dcb-qr-card--back' },
        h(
          'div',
          { className: 'dcb-qr-secret' },
          ...(status.totpSecret ?? '')
            .replace(/\s/g, '')
            .match(/.{1,4}/g)!
            .map((g, i) => h('span', { key: i, className: 'dcb-secret-group' }, g)),
        ),
      ),
    ),
    h(
      'div',
      { className: 'dcb-qr-actions' },
      h(
        'button',
        {
          className: 'dcb-iconbtn',
          onClick: () => void copyToClipboard(status.totpSecret ?? ''),
        },
        '复制',
      ),
      h('button', { className: 'dcb-iconbtn danger', onClick: onRotate }, '重置'),
    ),
  )
}

/** 配置开关分组。 */
function Group({
  status,
  onLocal,
  onTunnel,
  onBypass,
  onDevMode,
}: {
  status: BackendStatus
  onLocal: (on: boolean) => void
  onTunnel: (on: boolean) => void
  onBypass: (on: boolean) => void
  onDevMode: (on: boolean) => void
}): React.ReactElement {
  const localOn = status.localOn !== false
  const localSub = localOn
    ? (status.localUrl ?? '局域网可访问本机 3081 端口')
    : '已关闭，仅本机可访问'
  const tunnel = tunnelSubText(status)
  return h(
    'div',
    { className: 'dcb-group' },
    h(TierRow, {
      label: '本地共享',
      sub: localSub,
      copyText: localOn ? (status.localUrl ?? undefined) : undefined,
      checked: localOn,
      onChange: onLocal,
    }),
    h(TierRow, {
      label: '隧道映射',
      sub: tunnel.text,
      subTitle: status.url ?? undefined,
      copyText: tunnel.url ?? undefined,
      checked: status.mode !== 'local',
      onChange: onTunnel,
    }),
    h(TierRow, {
      label: '主站免密',
      sub: '从 deepc 后台打开节点时免输 2FA',
      checked: status.allowBypass ?? false,
      onChange: onBypass,
    }),
    h(TierRow, {
      label: '开发模式',
      sub: '使用本地 127.0.0.1:5174 基址',
      checked: status.devMode ?? false,
      onChange: onDevMode,
    }),
  )
}

/** 远端单行（时长 + 断开）。 */
function RemoteRow({
  status,
  onDisconnect,
}: {
  status: BackendStatus
  onDisconnect: () => void
}): React.ReactElement {
  const duration = useConnectedDuration(status.connectedAt, status.connected)
  return h(
    'div',
    { className: 'dcb-remote-row' },
    h(
      'div',
      { className: 'dcb-row-main' },
      h('div', { className: 'dcb-remote-duration' }, duration),
      h('div', { className: 'dcb-remote-status' }, '远程控制 · 本机配置不可见'),
    ),
    h('button', { className: 'dcb-iconbtn danger', onClick: onDisconnect }, '断开'),
  )
}

/** App 根组件（状态 + 组合 + 动画）。 */
function App({ remoteMode }: { remoteMode: boolean }): React.ReactElement {
  const [status, setStatus] = React.useState<BackendStatus>(INITIAL_STATUS)
  const [showQr, setShowQr] = React.useState(false)

  const fabRef = React.useRef<HTMLDivElement>(null)
  const sheetRef = React.useRef<HTMLDivElement>(null)
  const isOpenRef = React.useRef(false)
  const isHoveringRef = React.useRef(false)
  const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshStatus = React.useCallback(async (): Promise<void> => {
    const s = await deepcCall<BackendStatus>('status', undefined, remoteMode)
    if (s) setStatus(s)
  }, [remoteMode])

  // 首次拉取 + 本地轮询（远端只在打开 sheet 时拉一次）。
  React.useEffect(() => {
    void refreshStatus()
    if (remoteMode) return
    const poll = setInterval(() => void refreshStatus(), 3000)
    return () => clearInterval(poll)
  }, [refreshStatus, remoteMode])

  // 动画（animejs 直接操作 DOM style，不触发重渲染）。
  const cancelHide = React.useCallback((): void => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const hideFab = React.useCallback((): void => {
    if (fabRef.current) animate(fabRef.current, { translateX: 64, opacity: 0.35, duration: 240, ease: 'outQuad' })
  }, [])

  const showFab = React.useCallback((): void => {
    if (isOpenRef.current) return
    cancelHide()
    if (fabRef.current) animate(fabRef.current, { translateX: 0, opacity: 1, duration: 200, ease: 'outBack(1.7)' })
  }, [cancelHide])

  const scheduleHide = React.useCallback((): void => {
    cancelHide()
    hideTimerRef.current = setTimeout(() => {
      if (!isOpenRef.current && !isHoveringRef.current) hideFab()
    }, 1000)
  }, [cancelHide, hideFab])

  const openSheet = React.useCallback((): void => {
    if (isOpenRef.current) return
    isOpenRef.current = true
    cancelHide()
    const fab = fabRef.current
    const sheet = sheetRef.current
    if (fab) animate(fab, { scale: 0.3, opacity: 0, duration: 120, ease: 'outQuad' })
    if (sheet) {
      sheet.style.visibility = 'visible'
      sheet.style.pointerEvents = 'auto'
      animate(sheet, { scale: [0.4, 1], opacity: [0, 1], translateY: [16, 0], duration: 240, ease: 'outBack(1.7)' })
    }
  }, [cancelHide])

  const closeSheet = React.useCallback((): void => {
    if (!isOpenRef.current) return
    isOpenRef.current = false
    const fab = fabRef.current
    const sheet = sheetRef.current
    if (sheet) {
      sheet.style.pointerEvents = 'none'
      animate(sheet, {
        scale: [1, 0.5],
        opacity: [1, 0],
        translateY: [0, 12],
        duration: 150,
        ease: 'inQuad',
        onComplete: () => {
          sheet.style.visibility = 'hidden'
        },
      })
    }
    if (fab) animate(fab, { scale: [0.3, 1], opacity: [0, 1], duration: 150, ease: 'outBack(1.6)' })
    scheduleHide()
  }, [scheduleHide])

  // 点击 sheet 外关闭。
  React.useEffect(() => {
    const onDocClick = (): void => {
      if (isOpenRef.current) closeSheet()
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [closeSheet])

  // 初始即调度自动隐藏（对齐原 vanilla 实现的 bootstrap 时 scheduleHide）；
  // 组件卸载时清理计时器。
  React.useEffect(() => {
    scheduleHide()
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [scheduleHide])

  const onFabClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (isOpenRef.current) closeSheet()
    else {
      void refreshStatus()
      openSheet()
    }
  }

  const onLogin = (): void => {
    void deepcCall<{ url?: string }>('login').then((r) => {
      if (r?.url) window.open(r.url, '_blank')
      void refreshStatus()
    })
  }

  const onLogout = (): void => {
    const name = status.profile?.name?.trim() || status.profile?.login || '当前账号'
    if (window.confirm(`登出 ${name} 并断开互联？`)) {
      void deepcCall('logout').then(() => refreshStatus())
    }
  }

  const onLocal = (on: boolean): void => {
    void deepcCall<{ ok?: boolean }>('local', { on }).then(async (r) => {
      if (r && !r.ok) return
      await refreshStatus()
    })
  }

  const onTunnel = (on: boolean): void => {
    const target: LinkMode = on ? (status.loggedIn ? 'managed' : 'tunnel') : 'local'
    void deepcCall('mode', { mode: target }).then(() => refreshStatus())
  }

  const onBypass = (on: boolean): void => {
    void deepcCall('bypass', { enabled: on }).then(() => refreshStatus())
  }

  const onDevMode = (on: boolean): void => {
    void deepcCall('devmode', { enabled: on }).then(() => refreshStatus())
  }

  const onDisconnect = (): void => {
    void deepcCall('disconnect')
  }

  const onRotate = (): void => {
    void deepcCall('totp-rotate').then(() => refreshStatus())
  }

  return h(
    'div',
    { id: HOST_ZONE_ID },
    h(Fab, {
      ref: fabRef,
      innerHtml: DEEPSEA_LOGO,
      title: 'deepSea 互联',
      onClick: onFabClick,
      onMouseEnter: () => {
        isHoveringRef.current = true
        cancelHide()
      },
      onMouseLeave: () => {
        isHoveringRef.current = false
        if (!isOpenRef.current) scheduleHide()
      },
    }),
    h(
      'div',
      { id: SHEET_ID, ref: sheetRef, onClick: (e: React.MouseEvent) => e.stopPropagation() },
      h(Head, { status, onLogin, onLogout }),
      h(
        'div',
        { className: 'dcb-body' },
        remoteMode
          ? h(RemoteRow, { status, onDisconnect })
          : h(
              React.Fragment,
              null,
              showQr ? h(QrPanel, { status, onClose: () => setShowQr(false), onRotate }) : h(OtpPanel, { status, onShowQr: () => setShowQr(true) }),
              h(Group, { status, onLocal, onTunnel, onBypass, onDevMode }),
            ),
      ),
    ),
    h('div', {
      id: TRIGGER_ID,
      onMouseEnter: () => {
        isHoveringRef.current = true
        showFab()
      },
      onMouseLeave: () => {
        isHoveringRef.current = false
        if (!isOpenRef.current) scheduleHide()
      },
    }),
  )
}

let bootstrapped = false

/** 注入悬浮球 + Sheet，返回控制句柄（幂等 + 域守卫）。 */
export function bootstrapHostUi(): HostUi {
  if (bootstrapped || isRemoteContext()) {
    return { state: 'idle', dispose: () => {} }
  }
  bootstrapped = true
  const remoteMode = !isLoopbackHost(window.location.hostname)

  const style = document.createElement('style')
  style.id = HOST_UI_STYLE_ID
  style.textContent = HOST_UI_CSS
  document.head.appendChild(style)

  const mount = document.createElement('div')
  document.body.appendChild(mount)

  const root = createRoot(mount)
  root.render(h(App, { remoteMode }))

  return {
    state: 'ready',
    dispose(): void {
      root.unmount()
      mount.remove()
      style.remove()
      bootstrapped = false
    },
  }
}

/** 是否已注入（幂等守卫，供外部判断）。 */
export function hostUiInjected(): boolean {
  return bootstrapped || document.getElementById(HOST_UI_STYLE_ID) !== null
}
