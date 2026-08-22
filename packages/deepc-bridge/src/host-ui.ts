/**
 * deepc-bridge 插件端悬浮球 UI —— deepSea 图标悬浮球（右下角）+ 变形 Sheet。
 *
 * 跑在本地 dsh 前端（browser 端 cordis 插件）。用原生 DOM + 注入独立命名空间
 * CSS 实现，不依赖 dsh 前端的样式系统，避免污染官方 UI。动效用 animejs。
 *
 * 交互：
 *   右下角 deepSea 图标 → 点击「变形成」卡片式 Sheet（从图标位置向上生长）
 *   点击 Sheet 外部 → 收起回图标
 *   图标无操作 1s → 向右滑出屏幕外侧（藏起）
 *   鼠标靠近右下角触发角 → 图标滑回
 *   Sheet header：`(deepc logo) deepSea` + 登录按钮；body：配置同步 + 状态
 *
 * 前端**只做展示**：登录态/开关/同步/断开均经 `/deepc/*` 调插件后端（node 端）
 * 执行（见 plan §3.4 前后端分层）。后端自持 token/注册/心跳/信令/deepc.* 能力。
 * 临时连接已移除（见 docs/deepsea-deepc-bridge-config-gist.md）。
 */

import { animate } from 'animejs'

/** 后端控制路由基址（与 node-host.ts 的 NODE_CTRL_PATH 一致；同源 3080）。 */
const DEEPC_CTRL_BASE = '/deepc'

/** 调用插件后端控制端点。 */
async function deepcCall<T>(action: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${DEEPC_CTRL_BASE}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** 后端状态（对齐 node-host.ts 的 NodeHostStatus）。 */
interface BackendStatus {
  loggedIn: boolean
  deviceName: string
  sessions: number
  allowInterconnect: boolean
  error?: string
  profile?: { login: string; avatar_url: string; name: string | null }
}

/** 悬浮球 + sheet + 触发热区根节点 id（幂等守卫）。 */
const HOST_ZONE_ID = '__deepc_bridge_zone'
const FAB_ID = '__deepc_bridge_fab'
const SHEET_ID = '__deepc_bridge_sheet'
const TRIGGER_ID = '__deepc_bridge_trigger'

/** deepSea 品牌图标（内联 SVG，蓝色圆角底 + 三波浪线，与主站 deepsea.svg 一致）。 */
const DEEPSEA_LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6.5" fill="#16b3eb"/><g transform="translate(4 4) scale(0.6667)" stroke="#02080f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12 q2.5 2 5 0 t5 0 t5 0 t5 0"/><path d="M2 19 q2.5 2 5 0 t5 0 t5 0 t5 0"/><path d="M2 5 q2.5 2 5 0 t5 0 t5 0 t5 0"/></g></svg>`

/** 深蓝玻璃风格配色（与主站统一）。 */
const CSS = `
#${HOST_ZONE_ID}, #${HOST_ZONE_ID} * { box-sizing: border-box; }
#${FAB_ID} {
  position: fixed; bottom: 16px; right: 16px;
  width: 42px; height: 42px; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  border-radius: 12px; cursor: pointer;
  background: rgba(10,15,28,.92);
  border: 1px solid rgba(148,163,184,.25);
  box-shadow: 0 6px 20px rgba(2,8,24,.5);
  overflow: hidden;
}
#${FAB_ID}:hover { border-color: rgba(22,179,235,.55); }
#${SHEET_ID} {
  position: fixed; bottom: 16px; right: 16px; width: 324px; z-index: 2147482999;
  background: rgba(10,15,28,.97);
  border: 1px solid rgba(148,163,184,.18);
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(2,8,24,.65);
  transform-origin: 100% 100%;
  display: flex; flex-direction: column; color: #e2e8f0; font-family: system-ui, sans-serif;
  overflow: hidden;
  opacity: 0; pointer-events: none; visibility: hidden;
}
#${TRIGGER_ID} {
  position: fixed; bottom: 0; right: 0; width: 96px; height: 96px; z-index: 2147482998;
  pointer-events: auto;
}
.dcb-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid rgba(148,163,184,.15); }
.dcb-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.dcb-brand-title { font-size: 15px; font-weight: 700; color: #f1f5f9; line-height: 1.15; }
.dcb-brand-sub { font-size: 11px; color: #94a3b8; }
.dcb-auth { flex-shrink: 0; }
.dcb-login-btn { padding: 7px 12px; border-radius: 8px; border: 1px solid rgba(125,211,252,.4); background: rgba(125,211,252,.1); color: #7dd3fc; cursor: pointer; font-size: 12px; font-weight: 500; }
.dcb-login-btn:hover { background: rgba(125,211,252,.2); }
.dcb-user-avatar { width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0; background: #334155; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #7dd3fc; overflow: hidden; border: 1px solid rgba(148,163,184,.25); }
.dcb-user-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dcb-brand-text { min-width: 0; }
.dcb-brand-text .dcb-brand-title { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcb-logout-btn { padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,.3); background: transparent; color: #94a3b8; cursor: pointer; font-size: 12px; flex-shrink: 0; transition: color .15s ease, border-color .15s ease, background .15s ease; }
.dcb-logout-btn:hover { color: #e2e8f0; border-color: rgba(148,163,184,.5); }
.dcb-logout-btn.confirm { background: rgba(251,113,133,.15); border-color: rgba(251,113,133,.45); color: #fb7185; }
.dcb-body { padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.dcb-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dcb-row-text { min-width: 0; }
.dcb-row-label { font-size: 13px; font-weight: 600; color: #e2e8f0; }
.dcb-row-desc { font-size: 11px; color: #94a3b8; margin-top: 2px; line-height: 1.5; }
.dcb-switch { position: relative; display: inline-block; width: 42px; height: 24px; flex-shrink: 0; }
.dcb-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.dcb-switch .dcb-track { position: absolute; inset: 0; border-radius: 999px; background: rgba(100,116,139,.45); transition: background .18s ease; pointer-events: none; }
.dcb-switch .dcb-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #e2e8f0; transition: transform .18s ease; }
.dcb-switch input:checked + .dcb-track { background: #16b3eb; }
.dcb-switch input:checked + .dcb-track::after { transform: translateX(18px); }
.dcb-id-label { font-size: 11px; color: #94a3b8; margin-bottom: 6px; display: block; }
.dcb-id-box { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 10px; background: rgba(15,23,42,.7); border: 1px dashed rgba(125,211,252,.4); }
.dcb-id-box code { flex: 1; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: #7dd3fc; word-break: break-all; line-height: 1.5; }
.dcb-copy { flex-shrink: 0; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(125,211,252,.35); background: transparent; color: #7dd3fc; cursor: pointer; font-size: 11px; }
.dcb-copy:hover { background: rgba(125,211,252,.15); }
.dcb-countdown { text-align: center; font-size: 12px; color: #fbbf24; font-family: ui-monospace, monospace; margin-top: 8px; }
.dcb-btn { width: 100%; padding: 10px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: filter .15s ease; }
.dcb-btn:hover { filter: brightness(1.1); }
.dcb-btn-amber { background: rgba(251,191,36,.15); color: #fbbf24; border: 1px solid rgba(251,191,36,.35); }
.dcb-btn-ghost { background: rgba(125,211,252,.08); color: #7dd3fc; border: 1px solid rgba(125,211,252,.3); }
.dcb-sync-mini { width: auto; flex-shrink: 0; padding: 5px 12px; border-radius: 8px; font-size: 12px; }
.dcb-backup-row { display: flex; gap: 8px; }
.dcb-backup-row .dcb-btn { width: auto; flex: 1; }
.dcb-note { font-size: 11px; color: #94a3b8; line-height: 1.5; margin: 0; }
.dcb-pass-input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,.25); background: rgba(15,23,42,.6); color: #e2e8f0; font-size: 13px; outline: none; }
.dcb-pass-input:focus { border-color: rgba(125,211,252,.5); }
.dcb-status { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 8px 10px; border-radius: 8px; background: rgba(15,23,42,.6); }
.dcb-status .dcb-status-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcb-disconnect { flex-shrink: 0; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(251,191,36,.4); background: rgba(251,191,36,.12); color: #fbbf24; cursor: pointer; font-size: 11px; font-weight: 500; }
.dcb-disconnect:hover { background: rgba(251,191,36,.22); }
.dcb-manage-link { color: #7dd3fc; text-decoration: underline; cursor: pointer; margin-left: 2px; }
.dcb-manage-link:hover { color: #38bdf8; }
.dcb-dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; flex-shrink: 0; }
.dcb-dot.on { background: #34d399; }
.dcb-dot.offering { background: #38bdf8; }
.dcb-dot.error { background: #fb7185; }
`

type HostState = 'idle' | 'ready'

// ── 前端偏好（auto 用 localStorage 持久化；allow 由后端 status 回填）─────
const AUTO_KEY = 'deepc:autoEnable'

function readBoolSetting(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return fallback
    return v === 'true'
  } catch { return fallback }
}

function writeBoolSetting(key: string, value: boolean): void {
  try { localStorage.setItem(key, String(value)) } catch { /* ignore */ }
}

interface HostUi {
  state: HostState
  dispose: () => void
}

/** 渲染 header 登录区：brand 区显示 logo（未登录）/头像+昵称（已登录）；auth 区登录/登出按钮。 */
function renderAuth(
  brandEl: HTMLElement,
  authEl: HTMLElement,
  opts: {
    status: BackendStatus
    /** 点登录：调 /deepc/login，返回授权 URL 则打开。 */
    onLogin: () => Promise<void>
    /** 点登出：调 /deepc/logout。 */
    onLogout: () => Promise<void>
  }
): {
  cancel: () => void
  rerender: (next: BackendStatus) => void
} {
  // 取消「确认登出」态的回调（关闭 sheet 时由 bootstrapHostUi 调用）。
  let cancelConfirm: (() => void) | null = null

  const renderBrandLogo = (): void => {
    brandEl.innerHTML = `${DEEPSEA_LOGO}
      <div class="dcb-brand-text">
        <div class="dcb-brand-title">deepSea</div>
        <div class="dcb-brand-sub">deepc bridge</div>
      </div>`
  }

  const renderLogin = (): void => {
    cancelConfirm = null
    renderBrandLogo()
    authEl.innerHTML = `<button class="dcb-login-btn" id="dcb-login">登录</button>`
    authEl.querySelector('#dcb-login')?.addEventListener('click', () => {
      void opts.onLogin()
    })
  }

  const renderLoggedIn = (profile: NonNullable<BackendStatus['profile']>): void => {
    const name = profile.name?.trim() || profile.login
    // 头像对齐主站：referrerpolicy no-referrer 保证 GitHub 头像正常加载。
    // 用 DOM API 创建 img（避免 innerHTML 字符串注入时请求被中止缓存），
    // 加载失败 onerror 回退到 login 前两位大写（与主站 AvatarFallback 一致）。
    const avatarSpan = document.createElement('span')
    avatarSpan.className = 'dcb-user-avatar'
    if (profile.avatar_url) {
      const img = document.createElement('img')
      img.src = profile.avatar_url
      img.alt = name
      img.referrerPolicy = 'no-referrer'
      img.addEventListener('error', () => {
        avatarSpan.textContent = profile.login.slice(0, 2).toUpperCase()
      })
      avatarSpan.appendChild(img)
    } else {
      avatarSpan.textContent = profile.login.slice(0, 2).toUpperCase()
    }

    brandEl.innerHTML = ''
    brandEl.appendChild(avatarSpan)
    const textDiv = document.createElement('div')
    textDiv.className = 'dcb-brand-text'
    textDiv.innerHTML = `
      <div class="dcb-brand-title">${escapeHtml(name)}</div>
      <div class="dcb-brand-sub">@${escapeHtml(profile.login)}</div>`
    brandEl.appendChild(textDiv)
    authEl.innerHTML = `<button class="dcb-logout-btn" id="dcb-logout">登出</button>`

    // 登出需二次确认：点「登出」→「确认登出？」；3s 无操作自动取消。
    const logoutBtn = authEl.querySelector<HTMLButtonElement>('#dcb-logout')!
    let confirming = false
    let confirmTimer: ReturnType<typeof setTimeout> | null = null
    const resetConfirm = (): void => {
      confirming = false
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = null
      logoutBtn.textContent = '登出'
      logoutBtn.classList.remove('confirm')
    }
    cancelConfirm = resetConfirm
    logoutBtn.addEventListener('click', () => {
      if (!confirming) {
        confirming = true
        logoutBtn.textContent = '确认登出？'
        logoutBtn.classList.add('confirm')
        confirmTimer = setTimeout(resetConfirm, 3000)
      } else {
        resetConfirm()
        void opts.onLogout()
      }
    })
  }

  /** 根据后端状态快照刷新 header。 */
  function render(status: BackendStatus): void {
    if (status.loggedIn && status.profile) {
      renderLoggedIn(status.profile)
    } else {
      renderLogin()
    }
  }
  render(opts.status)

  return {
    /** 关闭 sheet 时取消「确认登出」态。 */
    cancel: () => {
      cancelConfirm?.()
    },
    /** 后端状态变化时刷新登录 header（登录/登出前头像主体）。 */
    rerender: (next: BackendStatus) => {
      render(next)
    },
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}

/** 秒数格式化为 HH:MM:SS 或 MM:SS（连接时长展示）。 */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 判断是否已注入（幂等守卫）。 */
export function hostUiInjected(): boolean {
  return document.getElementById(HOST_ZONE_ID) !== null
}

/** 域守卫：远端快照/非本地 dsh 上下文不注入（防双角色死循环）。 */
function isRemoteContext(): boolean {
  const { hostname, port } = window.location
  return hostname === 'sonar-landing-page.deepc.cn' || port === '8789'
}

/** 注入悬浮球 + Sheet 卡片，返回控制句柄。 */
export function bootstrapHostUi(): HostUi {
  if (hostUiInjected() || isRemoteContext()) {
    return { state: 'idle', dispose: () => {} }
  }

  // 注入独立命名空间 CSS
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // 悬浮球（右下角，deepSea 品牌图标）
  const fab = document.createElement('div')
  fab.id = FAB_ID
  fab.innerHTML = DEEPSEA_LOGO
  fab.title = 'deepSea 互联'

  // Sheet 卡片（从图标位置向上生长）
  const sheet = document.createElement('div')
  sheet.id = SHEET_ID
  sheet.innerHTML = `
    <div class="dcb-head">
      <div class="dcb-brand" id="dcb-brand">
        ${DEEPSEA_LOGO}
        <div>
          <div class="dcb-brand-title">deepSea</div>
          <div class="dcb-brand-sub">deepc bridge</div>
        </div>
      </div>
      <div class="dcb-auth" id="dcb-auth"></div>
    </div>
    <div class="dcb-body">
      <div>
        <div class="dcb-row-label" style="margin-bottom:6px">互联设置</div>
        <div class="dcb-row" style="margin-bottom:8px">
          <div class="dcb-row-text">
            <div class="dcb-row-label">允许互联</div>
            <div class="dcb-row-desc">关闭后拒绝新的远端连接</div>
          </div>
          <label class="dcb-switch"><input type="checkbox" id="dcb-allow" checked><span class="dcb-track"></span></label>
        </div>
        <div class="dcb-row">
          <div class="dcb-row-text">
            <div class="dcb-row-label">自动开启</div>
            <div class="dcb-row-desc">登录后自动启动互联服务</div>
          </div>
          <label class="dcb-switch"><input type="checkbox" id="dcb-auto" checked><span class="dcb-track"></span></label>
        </div>
      </div>
      <div>
        <div class="dcb-row-label" style="margin-bottom:6px">配置同步</div>
        <div class="dcb-row">
          <div class="dcb-row-text">
            <div class="dcb-row-label">同步</div>
            <div class="dcb-row-desc">登录后自动同步，跨设备共享配置（theme/model/偏好）</div>
          </div>
          <button class="dcb-btn dcb-btn-ghost dcb-sync-mini" id="dcb-sync-now">同步</button>
        </div>
        <div id="dcb-backup-panel" style="margin-top:10px"></div>
      </div>
      <div class="dcb-status"><span class="dcb-dot" id="dcb-dot"></span><span class="dcb-status-label" id="dcb-status-text">未连接</span><button class="dcb-disconnect" id="dcb-disconnect" style="display:none">断开</button></div>
    </div>
  `

  // 右下角触发热区（鼠标靠近时唤出图标）
  const trigger = document.createElement('div')
  trigger.id = TRIGGER_ID

  document.body.appendChild(fab)
  document.body.appendChild(sheet)
  document.body.appendChild(trigger)

  // 交互状态
  let state: HostState = 'idle'
  let isOpen = false
  let isHovering = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  const authEl = sheet.querySelector<HTMLElement>('#dcb-auth')!
  const brandEl = sheet.querySelector<HTMLElement>('#dcb-brand')!
  const dot = sheet.querySelector<HTMLElement>('#dcb-dot')!
  const statusText = sheet.querySelector<HTMLElement>('#dcb-status-text')!
  const disconnectBtn = sheet.querySelector<HTMLElement>('#dcb-disconnect')!
  const syncNowBtn = sheet.querySelector<HTMLElement>('#dcb-sync-now')!
  const backupPanel = sheet.querySelector<HTMLElement>('#dcb-backup-panel')!
  const allowToggle = sheet.querySelector<HTMLInputElement>('#dcb-allow')!
  const autoToggle = sheet.querySelector<HTMLInputElement>('#dcb-auto')!

  // 前端互联展示态（从后端 status 同步；auto 为前端偏好，localStorage 持久化）。
  let status: BackendStatus = { loggedIn: false, deviceName: '', sessions: 0, allowInterconnect: true }

  // 初始化 toggle（auto 为前端偏好；allow 由后端 status 回填）。
  autoToggle.checked = readBoolSetting(AUTO_KEY, true)
  allowToggle.checked = true

  allowToggle.addEventListener('change', () => {
    void deepcCall('allow', { enabled: allowToggle.checked })
  })

  autoToggle.addEventListener('change', () => {
    writeBoolSetting(AUTO_KEY, autoToggle.checked)
  })

  function setStatus(label: string, dotState: string): void {
    statusText.textContent = label
    dot.className = `dcb-dot ${dotState}`
  }

  /** 根据后端状态快照刷新状态栏 + header + 开关。 */
  function applyStatus(next: BackendStatus): void {
    status = next
    rerenderAuth(next)
    allowToggle.checked = next.allowInterconnect
    // 状态栏：连接态 > 已登录就绪 > 未登录。
    if (next.sessions > 0) {
      renderConnection(next.sessions)
    } else if (next.loggedIn) {
      stopElapsed()
      disconnectBtn.style.display = 'none'
      if (next.error === 'quota-exceeded') {
        showQuotaExceeded()
      } else if (!next.allowInterconnect) {
        setStatus('互联已关闭', '')
      } else {
        setStatus('多端直连就绪', 'on')
      }
    } else if (next.error === 'quota-exceeded') {
      showQuotaExceeded()
    } else {
      stopElapsed()
      disconnectBtn.style.display = 'none'
      setStatus(next.error === 'login-timeout' ? '登录超时' : '未连接', '')
    }
  }

  /** 拉取后端状态并刷新 UI。 */
  async function refreshStatus(): Promise<void> {
    const s = await deepcCall<BackendStatus>('status')
    if (s) applyStatus(s)
  }

  // ── 已连接状态：计时 + 断开按钮（多端直连会话建立/断开时切换）────────
  let connectedSince: number | null = null
  let elapsedTimer: ReturnType<typeof setInterval> | null = null

  function stopElapsed(): void {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }

  /** 根据当前已建会话数切换状态栏：>0 已连接+计时+断开按钮；0 就绪态。 */
  function renderConnection(count: number): void {
    if (count > 0) {
      if (connectedSince === null) connectedSince = Date.now()
      stopElapsed()
      elapsedTimer = setInterval(() => {
        if (connectedSince !== null) {
          statusText.textContent = `已连接 · ${formatElapsed(Date.now() - connectedSince)}`
        }
      }, 1000)
      dot.className = 'dcb-dot on'
      statusText.textContent = `已连接 · ${formatElapsed(Date.now() - connectedSince)}`
      disconnectBtn.style.display = ''
    } else {
      connectedSince = null
      stopElapsed()
      disconnectBtn.style.display = 'none'
      setStatus('多端直连就绪', 'on')
    }
  }

  /** 超出节点纳管限制：状态栏提示 + 前往管理链接（不启动信令/心跳）。 */
  function showQuotaExceeded(): void {
    dot.className = 'dcb-dot error'
    statusText.innerHTML = `已超出3个dsh节点纳管限制 <a class="dcb-manage-link" href="${escapeAttr(
      '/sonar'
    )}" target="_blank" rel="noopener noreferrer">前往管理</a>`
  }

  // ── 展开/收起动画（animejs：图标「变形成」sheet）─────────────────────
  function openSheet(): void {
    if (isOpen) return
    isOpen = true
    cancelHide() // 打开状态不自动隐藏
    // 图标缩小淡出，sheet 从右下角向上「生长」+ 弹性
    animate(fab, {
      scale: 0.3,
      opacity: 0,
      duration: 120,
      easing: 'outQuad',
    })
    sheet.style.visibility = 'visible'
    sheet.style.pointerEvents = 'auto'
    animate(sheet, {
      scale: [0.4, 1],
      opacity: [0, 1],
      translateY: [16, 0],
      duration: 240,
      easing: 'spring(1, 80, 12, 0)',
    })
  }

  function closeSheet(): void {
    if (!isOpen) return
    isOpen = false
    cancelLogoutConfirm() // 点击外侧收起时，取消「确认登出」态
    sheet.style.pointerEvents = 'none'
    animate(sheet, {
      scale: [1, 0.5],
      opacity: [1, 0],
      translateY: [0, 12],
      duration: 150,
      easing: 'inQuad',
      complete: () => {
        sheet.style.visibility = 'hidden'
      },
    })
    animate(fab, {
      scale: [0.3, 1],
      opacity: [0, 1],
      duration: 150,
      easing: 'outBack(1.6)',
    })
    scheduleHide() // 收起回图标后重新计时
  }

  // ── 自动隐藏 / 触角唤出（仅「最小化且未 hover」时无操作 1s 右滑藏起）──
  function cancelHide(): void {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function scheduleHide(): void {
    cancelHide()
    hideTimer = setTimeout(() => {
      if (!isOpen && !isHovering) hideFab()
    }, 1000)
  }

  function hideFab(): void {
    animate(fab, {
      translateX: 64,
      opacity: 0.35,
      duration: 240,
      easing: 'outQuad',
    })
  }

  function showFab(): void {
    if (isOpen) return
    cancelHide()
    animate(fab, {
      translateX: 0,
      opacity: 1,
      duration: 200,
      easing: 'outBack(1.7)',
    })
  }

  // 前端只做展示：登录/登出/开关/同步/断开都经 /deepc 调后端。
  const { cancel: cancelLogoutConfirm, rerender: rerenderAuth } = renderAuth(brandEl, authEl, {
    status,
    onLogin: async () => {
      const r = await deepcCall<{ url?: string; ok: boolean; reason?: string }>('login')
      if (r?.url) window.open(r.url, '_blank')
      void refreshStatus()
    },
    onLogout: async () => {
      await deepcCall('logout')
      await refreshStatus()
    },
  })

  // 图标点击：变形展开
  fab.addEventListener('click', (e) => {
    e.stopPropagation()
    if (isOpen) closeSheet()
    else openSheet()
  })

  // Sheet 内部点击不冒泡到 document（避免误关闭）
  sheet.addEventListener('click', (e) => {
    e.stopPropagation()
  })

  // 点击外部 → 收起
  document.addEventListener('click', () => {
    if (isOpen) closeSheet()
  })

  // hover 状态：鼠标在图标上时不自动隐藏
  fab.addEventListener('mouseenter', () => {
    isHovering = true
    cancelHide()
  })
  fab.addEventListener('mouseleave', () => {
    isHovering = false
    if (!isOpen) scheduleHide()
  })

  // 触发热区：鼠标靠近右下角 → 图标滑回；离开后无操作 1s 再隐藏
  trigger.addEventListener('mouseenter', () => {
    isHovering = true
    showFab()
  })
  trigger.addEventListener('mouseleave', () => {
    isHovering = false
    if (!isOpen) scheduleHide()
  })

  // 初始（最小化状态）即开始计时
  scheduleHide()

  // ── 插件端主动断开所有多端直连（经 /deepc/disconnect）──────────────
  disconnectBtn.addEventListener('click', () => {
    void deepcCall('disconnect').then(() => refreshStatus())
  })

  // ── 配置同步（经 /deepc/sync，刷新状态按 sessions 更新）─────────────
  syncNowBtn.addEventListener('click', () => {
    backupPanel.innerHTML = `<p class="dcb-note">触发同步…</p>`
    void deepcCall('sync').then(() => {
      backupPanel.innerHTML = `<p class="dcb-note" style="color:#34d399">同步完成</p>`
      return refreshStatus()
    })
  })

  // 初始拉取一次后端状态。
  void refreshStatus()

  return {
    get state() {
      return state
    },
    dispose(): void {
      if (hideTimer) clearTimeout(hideTimer)
      stopElapsed()
      fab.remove()
      sheet.remove()
      trigger.remove()
      style.remove()
    },
  }
}
