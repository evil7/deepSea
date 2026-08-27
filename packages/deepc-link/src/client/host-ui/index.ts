/**
 * host-ui 入口 —— deepSea 悬浮球 + Sheet（React 版，模块化）。
 *
 * 用 react-dom/client 的 createRoot 挂载（react-dom 由 dsh 前端 seed 提供，见 build.mjs external）。
 * 动画保留 animejs（操作 DOM style，与 React 渲染共存：React 只管内容，动画管容器 visibility/opacity/transform）。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { animate } from 'animejs'
import { useTranslation } from 'react-i18next'

import { deepcCall, prettySubdomain, prettyHost, copyToClipboard } from './api'
import { HOST_ZONE_ID, HOST_UI_STYLE_ID, SHEET_ID, TRIGGER_ID, isOfficialLocalOrigin, isRemoteContext } from './constants'
import { HOST_UI_CSS } from './styles'
import { DEEPSEA_LOGO, QR_ICON, USER_ICON, BACK_ICON, CHECK_ICON } from './icons'
import { Avatar, Fab, Icon, TierRow } from './components'
import { useConnectedDuration, useQrDataUrl, useTotpCode } from './hooks'
import { applyRemoteChrome } from '../remote-chrome'
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

/** 隧道状态机 → 副文案（t 由调用组件传入，保持纯函数）。 */
function tunnelSubText(
  status: BackendStatus,
  t: (key: string) => string,
): { text: string; url: string | null } {
  const st = status.tunnelState ?? 'off'
  switch (st) {
    case 'off':
      return { text: t('host.tunnelOff'), url: null }
    case 'download-pending':
      return { text: t('host.tunnelDownloadPending'), url: null }
    case 'downloading':
      return { text: t('host.tunnelDownloading'), url: null }
    case 'downloaded':
      return { text: t('host.tunnelDownloaded'), url: null }
    case 'starting':
      return { text: t('host.tunnelStarting'), url: null }
    case 'running':
    case 'managed': {
      // 最终态：去掉「已纳管/已启动」前缀，只显示二级域字段；无 url 时兑底显示状态文案。
      return status.url
        ? { text: prettySubdomain(status.url), url: status.url }
        : { text: st === 'managed' ? t('host.tunnelManaged') : t('host.tunnelRunning'), url: null }
    }
    default:
      return { text: t('host.tunnelStarting'), url: null }
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
  const { t } = useTranslation()
  const p = status.profile
  const brand = h(
    'div',
    { className: 'dcb-brand' },
    h(Icon, { svg: DEEPSEA_LOGO }),
    h(
      'div',
      null,
      h('div', { className: 'dcb-brand-title' }, 'deepSea'),
      h('div', { className: 'dcb-brand-sub' }, t('host.brandSub')),
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
          { className: 'dcb-head-user', title: t('host.clickToLogout'), onClick: onLogout },
          h('span', { className: 'dcb-user-name' }, name),
          h(Avatar, { login: p.login, avatarUrl: p.avatar_url }),
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
        title: t('host.loginMain'),
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
  const { t } = useTranslation()
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
        t('host.otpLabel'),
        h('button', {
          className: 'dcb-otp-qr-trigger',
          title: t('host.showQrTitle'),
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
  const { t } = useTranslation()
  const qrUrl = useQrDataUrl(status.otpauthUri)
  const [copied, setCopied] = React.useState(false)
  return h(
    'div',
    { className: 'dcb-card dcb-qr-panel' },
    h(
      'div',
      { className: 'dcb-otp-head' },
      h('span', { className: 'dcb-otp-label' }, t('host.bind2fa')),
      h(
        'button',
        { className: 'dcb-iconbtn dcb-qr-back', title: t('host.back'), onClick: onClose },
        h(Icon, { svg: BACK_ICON, className: 'dcb-qr-back-icon' }),
        t('host.back'),
      ),
    ),
    h(
      'div',
      { className: 'dcb-qr-deck' },
      h(
        'div',
        { className: 'dcb-qr-card dcb-qr-card--front' },
        qrUrl
          ? h('img', { className: 'dcb-qr', alt: t('host.qrAlt'), src: qrUrl })
          : h('div', { className: 'dcb-qr-placeholder' }, status.otpauthUri ? t('host.qrGenerating') : t('host.qrFailed')),
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
          className: 'dcb-iconbtn' + (copied ? ' copied' : ''),
          onClick: () => {
            void copyToClipboard(status.totpSecret ?? '').then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })
          },
        },
        copied ? h(Icon, { svg: CHECK_ICON, className: 'dcb-qr-copy-check' }) : t('host.copy'),
      ),
      h('button', { className: 'dcb-iconbtn danger', onClick: onRotate }, t('host.reset')),
    ),
  )
}

/** 配置开关分组。 */
function Group({
  status,
  onLocal,
  onTunnel,
  onDevMode,
}: {
  status: BackendStatus
  onLocal: (on: boolean) => void
  onTunnel: (on: boolean) => void
  onDevMode: (on: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const localOn = status.localOn !== false
  // 地址只显示 ip:port（去 http:// 前缀）；复制仍复制完整 URL（可直接粘贴到浏览器访问）。
  const localSub = localOn
    ? (status.localUrl ? prettyHost(status.localUrl) : t('host.localAccess'))
    : t('host.localClosed')
  const tunnel = tunnelSubText(status, (k) => t(k as never))
  return h(
    'div',
    { className: 'dcb-group' },
    h(TierRow, {
      label: t('host.tierLocal'),
      sub: localSub,
      subTitle: status.localUrl ?? undefined,
      copyText: localOn ? (status.localUrl ?? undefined) : undefined,
      checked: localOn,
      onChange: onLocal,
    }),
    h(TierRow, {
      label: t('host.tierTunnel'),
      sub: tunnel.text,
      subTitle: status.url ?? undefined,
      copyText: tunnel.url ?? undefined,
      checked: status.mode !== 'local',
      onChange: onTunnel,
    }),
    h(TierRow, {
      label: t('host.tierDevMode'),
      sub: t('host.devModeSub'),
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
  const { t } = useTranslation()
  const duration = useConnectedDuration(status.connectedAt, status.connected)
  return h(
    'div',
    { className: 'dcb-remote-row' },
    h('span', { className: 'dcb-remote-duration' }, duration),
    h('button', { className: 'dcb-iconbtn danger', title: t('host.remoteDisconnectTitle'), onClick: onDisconnect }, t('host.remoteDisconnect')),
  )
}

/** App 根组件（状态 + 组合 + 动画）。 */
function App({ remoteMode }: { remoteMode: boolean }): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<BackendStatus>(INITIAL_STATUS)
  const [showQr, setShowQr] = React.useState(false)

  const fabRef = React.useRef<HTMLDivElement>(null)
  const sheetRef = React.useRef<HTMLDivElement>(null)
  const isOpenRef = React.useRef(false)
  const isHoveringRef = React.useRef(false)
  const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // 隧道切换中标记：乐观更新期间抑制轮询覆盖，避免后端 stopConnections 窗口内轮询拉回旧 mode 导致闪回。
  const tunnelSwitchingRef = React.useRef(false)

  const refreshStatus = React.useCallback(async (): Promise<void> => {
    const s = await deepcCall<BackendStatus>('status', undefined, remoteMode)
    if (s) setStatus(s)
  }, [remoteMode])

  // 首次拉取 + 本地轮询（远端只在打开 sheet 时拉一次）。
  // refreshStatus 内部含 setStatus，宏任务包裹避免 effect 同步路径调用
  // （React Compiler set-state-in-effect lint）。
  React.useEffect(() => {
    const id = setTimeout(() => void refreshStatus(), 0)
    if (remoteMode) return () => clearTimeout(id)
    const poll = setInterval(() => {
      if (!tunnelSwitchingRef.current) void refreshStatus()
    }, 3000)
    return () => {
      clearTimeout(id)
      clearInterval(poll)
    }
  }, [refreshStatus, remoteMode])

  // 远端 chrome：sidebar 品牌名 → 设备名 + title/favicon 动态化。
  React.useEffect(() => {
    if (remoteMode) applyRemoteChrome(status)
  }, [remoteMode, status])

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
    const name = status.profile?.name?.trim() || status.profile?.login || t('host.currentAccount')
    if (window.confirm(t('host.logoutConfirm', { name }))) {
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
    // 乐观更新：立即把开关/文案切到目标态，避免 cloudflared 下载/启动/上报的等待
    // （后端 connectOrFallback 最长 30s）让用户误以为点击失效。
    tunnelSwitchingRef.current = true
    setStatus((s) => ({
      ...s,
      mode: target,
      tunnelState: on ? 'starting' : 'off',
      url: on ? s.url : null,
    }))
    void deepcCall('mode', { mode: target }).finally(() => {
      tunnelSwitchingRef.current = false
      // 拿到真实状态覆盖：开启失败（下载/启动/超时）后端已自动回退 local → 开关变回关闭。
      void refreshStatus()
    })
  }

  const onDevMode = (on: boolean): void => {
    void deepcCall('devmode', { enabled: on }).then(() => refreshStatus())
  }

  const onDisconnect = (): void => {
    // 远端「断开」= 结束本次远端会话：仅关闭本页面窗口，不影响宿主机
    // （cloudflared / 3081 鉴权代理保持运行，本机配置与互联层不受影响）。
    window.close()
    // 兜底：window.close() 对非脚本打开的窗口会被浏览器静默拒绝；若页面仍在，
    // 替换为提示页，明确告知会话已结束、可安全关闭标签。
    setTimeout(() => {
      if (window.closed) return
      const ended = t('host.remoteEnded')
      document.body.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100vh;' +
        'font-family:system-ui,sans-serif;font-size:14px;color:#9aa6b8;background:#0f1115;">' +
        ended.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</div>'
    }, 300)
  }

  const onRotate = (): void => {
    void deepcCall('totp-rotate').then(() => refreshStatus())
  }

  // 悬浮球/触发区 hover 处理器：提取为命名函数（h() 渲染内联箭头内的 ref
  // 访问会被 React Compiler react(refs) 误判为渲染期访问）。
  const handleFabMouseEnter = (): void => {
    isHoveringRef.current = true
    cancelHide()
  }
  const handleFabMouseLeave = (): void => {
    isHoveringRef.current = false
    if (!isOpenRef.current) scheduleHide()
  }
  const handleTriggerMouseEnter = (): void => {
    isHoveringRef.current = true
    showFab()
  }
  const handleTriggerMouseLeave = (): void => {
    isHoveringRef.current = false
    if (!isOpenRef.current) scheduleHide()
  }

  return h(
    'div',
    { id: HOST_ZONE_ID },
    h(Fab, {
      ref: fabRef,
      innerHtml: DEEPSEA_LOGO,
      title: t('host.fabTitle'),
      onClick: onFabClick,
      onMouseEnter: handleFabMouseEnter,
      onMouseLeave: handleFabMouseLeave,
    }),
    h(
      'div',
      { id: SHEET_ID, ref: sheetRef, className: remoteMode ? 'dcb-remote-sheet' : undefined, onClick: (e: React.MouseEvent) => e.stopPropagation() },
      remoteMode ? null : h(Head, { status, onLogin, onLogout }),
      h(
        'div',
        { className: remoteMode ? 'dcb-body dcb-remote-body' : 'dcb-body' },
        remoteMode
          ? h(RemoteRow, { status, onDisconnect })
          : h(
              React.Fragment,
              null,
              showQr ? h(QrPanel, { status, onClose: () => setShowQr(false), onRotate }) : h(OtpPanel, { status, onShowQr: () => setShowQr(true) }),
              h(Group, { status, onLocal, onTunnel, onDevMode }),
            ),
      ),
    ),
    h('div', {
      id: TRIGGER_ID,
      onMouseEnter: handleTriggerMouseEnter,
      onMouseLeave: handleTriggerMouseLeave,
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
  const remoteMode = !isOfficialLocalOrigin()

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
