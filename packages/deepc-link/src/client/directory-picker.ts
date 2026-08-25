/**
 * deepc-link 浏览器端目录选择器 —— 远端（非 loopback）访问时替换 dsh 原生 OS 目录对话框。
 *
 * 背景：dsh 的 directory-picker-auto 在 bindHost=127.0.0.1 时挂载 native 后端（OS 对话框，
 * 弹在宿主机显示器上）。远端经 3081 鉴权代理访问时，native 对话框远端看不到、选不了路径。
 *
 * 方案：远端访问（非 loopback）时，本组件 register 进 dsh 的 directoryFlow 单席位 slot
 * （single kind，动态注册 entry shadow 掉 native occupant），提供浏览器内目录浏览 UI。
 * 目录枚举走插件自己的 /__deepc_api/*（带 dc_site 鉴权），不依赖 dsh 未挂载的 browse 后端。
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
  onOpen: (path: string) => void
  onClose: () => void
}

/** 内联样式（独立命名空间，不依赖 dsh 样式系统）。 */
const S: Record<string, React.CSSProperties> = {
  mask: {
    position: 'fixed', inset: 0, zIndex: 2147483500,
    background: 'rgba(2,8,24,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  dialog: {
    width: 'min(560px, 92vw)', maxHeight: 'min(480px, 88vh)', display: 'flex', flexDirection: 'column',
    background: '#10141d', border: '1px solid rgba(148,163,184,.18)', borderRadius: 14,
    boxShadow: '0 24px 64px rgba(2,8,24,.7)', color: '#e6ebf2', overflow: 'hidden',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
  },
  head: {
    padding: '14px 16px 10px', borderBottom: '1px solid rgba(148,163,184,.14)',
    fontSize: 14, fontWeight: 600, color: '#e6ebf2',
  },
  crumbs: {
    display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
    padding: '6px 12px', borderBottom: '1px solid rgba(148,163,184,.1)', maxHeight: 72, overflowY: 'auto',
  },
  crumb: {
    background: 'none', border: 'none', cursor: 'pointer', color: '#9aa6b8', fontSize: 12, padding: '2px 4px',
    borderRadius: 6, whiteSpace: 'nowrap',
  },
  crumbSep: { color: '#4a5568', fontSize: 12 },
  list: {
    flex: 1, overflowY: 'auto', padding: '6px 8px', minHeight: 200,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8,
    cursor: 'pointer', fontSize: 13, color: '#cbd5e1', border: '1px solid transparent',
  },
  rowSelected: { background: 'rgba(63,178,240,.14)', color: '#e6ebf2' },
  rowHidden: { opacity: .45 },
  icon: { color: '#f0b429', flexShrink: 0, fontSize: 14 },
  foot: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
    borderTop: '1px solid rgba(148,163,184,.14)',
  },
  newInput: {
    flex: 1, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(148,163,184,.22)', borderRadius: 8,
    color: '#e6ebf2', padding: '7px 10px', fontSize: 13, outline: 'none',
  },
  btn: {
    padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(148,163,184,.25)', cursor: 'pointer',
    background: 'rgba(255,255,255,.04)', color: '#e6ebf2', fontSize: 13,
  },
  btnPrimary: { background: '#3fb2f0', borderColor: '#3fb2f0', color: '#02080f', fontWeight: 600 },
  status: { padding: '8px 16px', fontSize: 12, color: '#9aa6b8' },
  err: { color: '#fb7185' },
}

/** 目录浏览对话框（远端路径选择 UI）。 */
export function DirectoryBrowser(props: DirectoryBrowserProps): React.ReactElement | null {
  const { open, busy, listDirectory, createDirectory, onOpen, onClose } = props
  const [listing, setListing] = React.useState<DirectoryListing | null>(null)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState('')

  // open 上升沿：加载 home；关闭时重置。
  React.useEffect(() => {
    if (!open) {
      setListing(null)
      setSelected(null)
      setCreating(false)
      setNewName('')
      setError('')
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
    { style: S.mask, onClick: (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() } },
    React.createElement(
      'div',
      { style: S.dialog },
      React.createElement('div', { style: S.head }, '选择工作区目录'),
      React.createElement(
        'div',
        { style: S.crumbs },
        ...listing.crumbs.map((c, i) =>
          React.createElement(
            React.Fragment,
            { key: c.path + i },
            React.createElement('button', { style: S.crumb, onClick: () => navigate(c.path) }, c.name),
            i < listing.crumbs.length - 1 ? React.createElement('span', { style: S.crumbSep }, '/') : null,
          ),
        ),
      ),
      React.createElement(
        'div',
        { style: S.list },
        loading
          ? React.createElement('div', { style: S.status }, '加载中…')
          : listing.entries.length === 0
            ? React.createElement('div', { style: S.status }, '（空目录）')
            : listing.entries.map((en) => {
                const sel = selected === en.path
                return React.createElement(
                  'div',
                  {
                    key: en.path,
                    style: { ...S.row, ...(sel ? S.rowSelected : {}), ...(en.hidden ? S.rowHidden : {}) },
                    onClick: () => navigate(en.path),
                    onDoubleClick: () => {
                      setSelected(en.path)
                      onOpen(en.path)
                    },
                  },
                  React.createElement('span', { style: S.icon }, '📁'),
                  React.createElement('span', null, en.name),
                )
              }),
        listing.truncated
          ? React.createElement('div', { style: S.status }, '文件夹过多，仅显示前 1000 项。')
          : null,
      ),
      creating
        ? React.createElement(
            'div',
            { style: S.foot },
            React.createElement('input', {
              style: S.newInput,
              autoFocus: true,
              placeholder: '文件夹名称',
              value: newName,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value),
              onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') doCreate()
                if (e.key === 'Escape') setCreating(false)
              },
            }),
            React.createElement('button', { style: S.btnPrimary, onClick: doCreate }, '创建'),
            React.createElement('button', { style: S.btn, onClick: () => setCreating(false) }, '取消'),
          )
        : React.createElement(
            'div',
            { style: S.foot },
            React.createElement(
              'button',
              { style: S.btn, onClick: () => setCreating(true) },
              '新建文件夹',
            ),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', { style: S.btn, onClick: onClose }, '取消'),
            React.createElement(
              'button',
              { style: S.btnPrimary, disabled: busy, onClick: () => onOpen(openTarget) },
              '打开',
            ),
          ),
      error ? React.createElement('div', { style: { ...S.status, ...S.err } }, error) : null,
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
    onOpen: props.onPicked as (p: string) => void,
    onClose: props.onCancel as () => void,
  })
}

/** 最小 slots 接口（避免引入 dsh client 类型；运行时由 cordis 注入真实 slots 服务）。 */
interface SlotsCtx {
  slots: {
    inject: (key: string, callback: () => unknown) => () => void
    register: (declaration: { name: string; inject: () => Record<string, unknown> }, component: unknown) => unknown
  }
}

/** 远端访问时，把浏览器内目录浏览 UI register 进 dsh 的 directoryFlow slot（shadow native）。 */
export function registerBrowseDirectoryPicker(ctx: SlotsCtx): void {
  const injected = (): Record<string, unknown> => ({
    listDirectory: (path?: string, signal?: AbortSignal): Promise<DirectoryListing> =>
      fetch(`/__deepc_api/list-dir${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`list-dir ${r.status}`)
          return r.json() as Promise<DirectoryListing>
        }),
    createDirectory: (path: string, name: string): Promise<string> =>
      fetch('/__deepc_api/create-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }),
      })
        .then((r) => r.json() as Promise<{ ok: boolean; path?: string; error?: string }>)
        .then((b) => {
          if (b.ok !== true || !b.path) throw new Error(b.error ?? 'create-dir failed')
          return b.path
        }),
  })
  // 与 dsh 官方 browse 插件一致的注入方式：等 ui-workspace declare 目录流 slot 后 register。
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register(
        { name: 'conversation.hero.workspace.directoryFlow', inject: injected },
        DirectoryBrowserFlow,
      )
      yield ctx.slots.register(
        { name: 'sidebar.workspaces.directoryFlow', inject: injected },
        DirectoryBrowserFlow,
      )
    }),
  )
}
