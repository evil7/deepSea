/**
 * deepc-link 浏览器端目录选择器 —— 全面替换 dsh 原生 OS 目录对话框（本地 + 远端统一）。
 *
 * 背景：dsh 的 directory-picker-auto 在 bindHost=127.0.0.1 且 win32/darwin 时恒挂载
 * native 后端（OS 对话框，弹在宿主机显示器上）——远端浏览器看不到也选不了，本地与远端
 * 体验割裂。
 *
 * 方案：本组件 register 进 dsh 的 directoryFlow 单席位 slot，以 priority:-1（低于官方
 * native picker 的默认 0）成为 single slot 的 winner，全面 shadow 掉 native occupant，
 * 提供浏览器内目录浏览 UI。本地（3080 直连）与远端（3081 反代，先过 TOTP 2FA）统一走
 * node 半 /deepc/list-dir + /deepc/create-dir 枚举，不依赖 dsh 未挂载的 browse 后端。
 */

import * as React from 'react'

interface DirEntry {
  name: string
  path: string
  hidden: boolean
}
interface DirCrumb {
  name: string
  path: string
  hidden: boolean
}
interface DirectoryListing {
  ok: true
  path: string
  home: string
  crumbs: DirCrumb[]
  entries: DirEntry[]
  truncated: boolean
}

interface DirectoryBrowserProps {
  open: boolean
  busy: boolean
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  createDirectory: (path: string, name: string) => Promise<string>
  listRoots: () => Promise<DirEntry[]>
  onOpen: (path: string) => void
  onClose: () => void
}

/** 注入的样式表 id（幂等守卫）。 */
const STYLE_ID = 'deepc-link-directory-picker-css'

/**
 * 目录选择器样式（独立命名空间 `__dcb_dp-`）。
 * 颜色一律用 dsh 的 `--dsw-alias-*` 变量（`body[data-ds-dark-theme]` 自动切换明暗主题），
 * 变量缺失时回退到暗色值。用 CSS 类（而非内联样式）以支持 :hover / :disabled / flex 布局。
 */
const CSS = `
.__dcb_dp-mask {
  position: fixed; inset: 0; z-index: 2147483500;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-mask-1, rgba(2,8,24,.55));
}
.__dcb_dp-dialog {
  width: min(560px, 92vw); height: min(480px, 82vh);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, #10141d);
  border: 1px solid var(--dsw-alias-border-l3, rgba(148,163,184,.18));
  border-radius: 14px;
  box-shadow: var(--dsw-shadow-lv3, 0 24px 64px rgba(2,8,24,.7));
  color: var(--dsw-alias-label-primary, #e6ebf2);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif);
}
.__dcb_dp-head {
  flex: none; padding: 14px 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.14));
  font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6ebf2);
}
.__dcb_dp-crumbs {
  flex: none; display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  padding: 6px 12px; max-height: 72px; overflow-y: auto;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(148,163,184,.1));
}
.__dcb_dp-crumb {
  background: none; border: none; cursor: pointer; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #9aa6b8); font-size: 12px;
  padding: 2px 4px; border-radius: 6px; font-family: inherit;
}
.__dcb_dp-crumb:hover { color: var(--dsw-alias-label-primary, #e6ebf2); }
.__dcb_dp-crumb-sep { color: var(--dsw-alias-label-caption, #4a5568); font-size: 12px; }
.__dcb_dp-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 8px; }
.__dcb_dp-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-radius: 8px; cursor: pointer; font-size: 13px;
  color: var(--dsw-alias-label-secondary, #cbd5e1); border: 1px solid transparent;
}
.__dcb_dp-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.__dcb_dp-row.__dcb_dp-sel {
  background: var(--dsw-alias-interactive-bg-active, rgba(63,178,240,.14));
  color: var(--dsw-alias-label-primary, #e6ebf2);
}
.__dcb_dp-row.__dcb_dp-hidden { opacity: .45; }
.__dcb_dp-icon {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary, #9aa6b8);
}
.__dcb_dp-row.__dcb_dp-sel .__dcb_dp-icon { color: var(--dsw-alias-label-primary, #e6ebf2); }
.__dcb_dp-foot {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.14));
}
.__dcb_dp-spacer { flex: 1; }
.__dcb_dp-input {
  flex: 1; min-width: 0; outline: none;
  background: var(--dsw-alias-bg-base, rgba(255,255,255,.04));
  border: 1px solid var(--dsw-alias-border-l3, rgba(148,163,184,.22));
  border-radius: 8px; color: var(--dsw-alias-label-primary, #e6ebf2);
  padding: 7px 10px; font-size: 13px; font-family: inherit;
}
.__dcb_dp-btn {
  padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: inherit;
  border: 1px solid var(--dsw-alias-border-l3, rgba(148,163,184,.25));
  background: var(--dsw-alias-button-ghost-active-fill, rgba(255,255,255,.04));
  color: var(--dsw-alias-label-primary, #e6ebf2);
}
.__dcb_dp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.__dcb_dp-btn.__dcb_dp-primary {
  background: var(--dsw-alias-button-primary-fill, #3fb2f0);
  border-color: var(--dsw-alias-button-primary-fill, #3fb2f0);
  color: var(--dsw-alias-label-primary-inverted, #02080f); font-weight: 600;
}
.__dcb_dp-btn.__dcb_dp-primary:hover { background: var(--dsw-alias-button-primary-hover, #3fb2f0); }
.__dcb_dp-btn:disabled { opacity: .5; cursor: not-allowed; }
.__dcb_dp-status { padding: 8px 16px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #9aa6b8); }
.__dcb_dp-err { color: var(--dsw-alias-state-error-primary, #fb7185); }
`

let styleInjected = false

/** 幂等注入样式表（浏览器端；非 DOM 环境静默跳过）。 */
function ensureStyle(): void {
  if (styleInjected || typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) {
    styleInjected = true
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  styleInjected = true
}

/** 文件夹图标（内联 SVG，lucide folder，stroke=currentColor 跟随主题色）。 */
const FOLDER_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`

/** 磁盘/盘符图标（内联 SVG，lucide hard-drive）。 */
const DRIVE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>`

/** 渲染内联矢量图标（span 容器承载 svg，颜色由 CSS color 控制）。 */
function icon(svg: string): React.ReactElement {
  return React.createElement('span', {
    className: '__dcb_dp-icon',
    dangerouslySetInnerHTML: { __html: svg },
  })
}

/** 目录浏览对话框（远端路径选择 UI）。 */
export function DirectoryBrowser(props: DirectoryBrowserProps): React.ReactElement | null {
  ensureStyle()
  const { open, busy, listDirectory, createDirectory, listRoots, onOpen, onClose } = props
  const [listing, setListing] = React.useState<DirectoryListing | null>(null)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  // Windows 盘符切换：rootsOpen=true 时列表区渲染盘符列表；roots 为可用盘符。
  const [rootsOpen, setRootsOpen] = React.useState(false)
  const [roots, setRoots] = React.useState<DirEntry[]>([])

  // open 上升沿：加载 home；关闭时重置。
  React.useEffect(() => {
    if (!open) {
      setListing(null)
      setSelected(null)
      setCreating(false)
      setNewName('')
      setError('')
      setRootsOpen(false)
      setRoots([])
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError('')
    listDirectory(undefined, ctrl.signal)
      .then((l) => {
        setListing(l)
        setSelected(l.path)
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError('目录加载失败')
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open || !listing) return null

  const navigate = (path: string): void => {
    setRootsOpen(false)
    setLoading(true)
    setError('')
    listDirectory(path)
      .then((l) => {
        setListing(l)
        setSelected(l.path)
      })
      .catch(() => setError('目录加载失败'))
      .finally(() => setLoading(false))
  }

  /** 打开盘符列表（Windows 多盘符切换）。 */
  const openRoots = (): void => {
    setError('')
    listRoots()
      .then((r) => {
        setRoots(r)
        setRootsOpen(true)
      })
      .catch(() => setError('读取盘符失败'))
  }

  /** 判断面包屑名是否为 Windows 盘符根（C:/D:/…）。 */
  const isRootCrumb = (name: string): boolean => /^[A-Za-z]:$/.test(name)

  const doCreate = (): void => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setError('')
    createDirectory(listing.path, name)
      .then((p) => {
        setNewName('')
        setCreating(false)
        navigate(p)
      })
      .catch(() => {
        setError('新建文件夹失败')
        setCreating(false)
      })
  }

  const openTarget = selected ?? listing.path

  return React.createElement(
    'div',
    { className: '__dcb_dp-mask', onClick: (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() } },
    React.createElement(
      'div',
      { className: '__dcb_dp-dialog' },
      React.createElement('div', { className: '__dcb_dp-head' }, '选择工作区目录'),
      React.createElement(
        'div',
        { className: '__dcb_dp-crumbs' },
        ...listing.crumbs.map((c, i) =>
          React.createElement(
            React.Fragment,
            { key: c.path + i },
            React.createElement(
              'button',
              {
                className: '__dcb_dp-crumb',
                // 盘符根 crumb（C:/D:…）点击 → 切换盘符列表；其余 crumb 点击 → 导航。
                onClick: () => {
                  if (isRootCrumb(c.name)) {
                    if (rootsOpen) setRootsOpen(false)
                    else openRoots()
                  } else {
                    navigate(c.path)
                  }
                },
              },
              c.name,
            ),
            i < listing.crumbs.length - 1 ? React.createElement('span', { className: '__dcb_dp-crumb-sep' }, '/') : null,
          ),
        ),
      ),
      React.createElement(
        'div',
        { className: '__dcb_dp-list' },
        rootsOpen
          ? roots.length === 0
            ? React.createElement('div', { className: '__dcb_dp-status' }, '（无可用盘符）')
            : roots.map((r) => (
                React.createElement(
                  'div',
                  {
                    key: r.path,
                    className: `__dcb_dp-row${selected === r.path ? ' __dcb_dp-sel' : ''}`,
                    onClick: () => navigate(r.path),
                    onDoubleClick: () => {
                      setSelected(r.path)
                      onOpen(r.path)
                    },
                  },
                  icon(DRIVE_ICON),
                  React.createElement('span', null, r.name),
                )
              ))
          : loading
            ? React.createElement('div', { className: '__dcb_dp-status' }, '加载中…')
            : listing.entries.length === 0
              ? React.createElement('div', { className: '__dcb_dp-status' }, '（空目录）')
              : listing.entries.map((en) => {
                  const sel = selected === en.path
                  return React.createElement(
                    'div',
                    {
                      key: en.path,
                      className: `__dcb_dp-row${sel ? ' __dcb_dp-sel' : ''}${en.hidden ? ' __dcb_dp-hidden' : ''}`,
                      onClick: () => navigate(en.path),
                      onDoubleClick: () => {
                        setSelected(en.path)
                        onOpen(en.path)
                      },
                    },
                    icon(FOLDER_ICON),
                    React.createElement('span', null, en.name),
                  )
                }),
        listing.truncated
          ? React.createElement('div', { className: '__dcb_dp-status' }, '文件夹过多，仅显示前 1000 项。')
          : null,
      ),
      creating
        ? React.createElement(
            'div',
            { className: '__dcb_dp-foot' },
            React.createElement('input', {
              className: '__dcb_dp-input',
              autoFocus: true,
              placeholder: '文件夹名称',
              value: newName,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value),
              onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') doCreate()
                if (e.key === 'Escape') setCreating(false)
              },
            }),
            React.createElement('button', { className: '__dcb_dp-btn __dcb_dp-primary', onClick: doCreate }, '创建'),
            React.createElement('button', { className: '__dcb_dp-btn', onClick: () => setCreating(false) }, '取消'),
          )
        : React.createElement(
            'div',
            { className: '__dcb_dp-foot' },
            React.createElement(
              'button',
              { className: '__dcb_dp-btn', onClick: () => setCreating(true) },
              '新建文件夹',
            ),
            React.createElement('div', { className: '__dcb_dp-spacer' }),
            React.createElement('button', { className: '__dcb_dp-btn', onClick: onClose }, '取消'),
            React.createElement(
              'button',
              { className: '__dcb_dp-btn __dcb_dp-primary', disabled: busy, onClick: () => onOpen(openTarget) },
              '打开',
            ),
          ),
      error ? React.createElement('div', { className: '__dcb_dp-status __dcb_dp-err' }, error) : null,
    ),
  )
}

/** 目录流 occupant：把 slot owner 对话映射到 DirectoryBrowser。 */
function DirectoryBrowserFlow(props: Record<string, unknown>): React.ReactElement | null {
  return React.createElement(DirectoryBrowser, {
    open: props.open as boolean,
    busy: props.busy as boolean,
    listDirectory: props.listDirectory as DirectoryBrowserProps['listDirectory'],
    createDirectory: props.createDirectory as DirectoryBrowserProps['createDirectory'],
    listRoots: props.listRoots as DirectoryBrowserProps['listRoots'],
    onOpen: props.onPicked as (p: string) => void,
    onClose: props.onCancel as () => void,
  })
}

/** 最小 slots 接口（避免引入 dsh client 类型；运行时由 cordis 注入真实 slots 服务）。 */
export interface SlotsCtx {
  slots: {
    inject: (key: string, callback: () => unknown) => () => void
    register: (
      declaration: { name: string; priority?: number; inject: () => Record<string, unknown> },
      component: unknown,
    ) => unknown
  }
}

/** 浏览器内目录浏览 UI：register 进 dsh 的 directoryFlow 单席位 slot，全面 shadow 原生 OS 选择器。 */
export function registerBrowseDirectoryPicker(ctx: SlotsCtx): void {
  const injected = (): Record<string, unknown> => ({
    listDirectory: (path?: string, signal?: AbortSignal): Promise<DirectoryListing> =>
      fetch(`/deepc/list-dir${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`list-dir ${r.status}`)
          return r.json() as Promise<DirectoryListing>
        }),
    createDirectory: (path: string, name: string): Promise<string> =>
      fetch('/deepc/create-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }),
      })
        .then((r) => r.json() as Promise<{ ok: boolean; path?: string; error?: string }>)
        .then((b) => {
          if (b.ok !== true || !b.path) throw new Error(b.error ?? 'create-dir failed')
          return b.path
        }),
    listRoots: (): Promise<DirEntry[]> =>
      fetch('/deepc/list-roots')
        .then((r) => r.json() as Promise<{ ok: boolean; roots?: DirEntry[] }>)
        .then((b) => (b.ok === true && Array.isArray(b.roots) ? b.roots : [])),
  })
  // 与 dsh 官方 browse 插件一致的注入方式：等 ui-workspace declare 目录流 slot 后 register。
  // priority: -1 —— 低于官方 native picker（默认 0）。single slot 的 winner = priority 最小者，
  // 同 priority 会判非法注册（此前 shadow 失败根因）；-1 即成为 winner，全面替换原生 OS 选择器。
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register(
        { name: 'conversation.hero.workspace.directoryFlow', priority: -1, inject: injected },
        DirectoryBrowserFlow,
      )
      yield ctx.slots.register(
        { name: 'sidebar.workspaces.directoryFlow', priority: -1, inject: injected },
        DirectoryBrowserFlow,
      )
    }),
  )
}
