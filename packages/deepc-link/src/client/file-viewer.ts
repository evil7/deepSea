/**
 * deepc-link 远端文件查看器 —— 拦截 dsh 的 host.openPath（宿主机打开），改为浏览器内预览。
 *
 * dsh 的 Web UI 点击交付物文件路径时走 host.openPath RPC，把路径交给宿主机桌面默认应用
 * 打开——远端浏览器看不到。本组件在远端接管：fetch /deepc/read-file 拉取内容，弹浏览器内
 * 只读查看器（目录逐层导航 / 文本等宽预览 / 二进制提示）。
 *
 * 参考 GitHub 竞品 xgone/dsh-remote 的 /auth/file + SidePanelHost（Claude Desktop 式），
 * 此处简化为单文件 modal（非多 pane），保持独立命名空间与 dsh 主题变量适配。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'

/** 与 node 端 directory.ts 的 FilePreview 对齐（浏览器端仅消费，独立声明）。 */
interface DirEntry {
  name: string
  path: string
  hidden: boolean
}
interface FileListing {
  ok: true
  path: string
  home: string
  crumbs: { name: string; path: string; hidden: boolean }[]
  entries: DirEntry[]
  truncated: boolean
}
interface FilePreview {
  ok: boolean
  kind?: 'text' | 'binary' | 'directory'
  path?: string
  name?: string
  size?: number
  ext?: string
  text?: string
  listing?: FileListing
  error?: string
}

/** 单例 viewer 状态（path 非空即打开）。 */
interface ViewerState {
  path: string | null
}
let state: ViewerState = { path: null }
const listeners = new Set<() => void>()
function setState(next: ViewerState): void {
  state = next
  for (const l of listeners) l()
}
function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
function getSnapshot(): ViewerState {
  return state
}

/** 打开路径预览（幂等：同一路径不重复打开）。 */
export function openFilePreview(path: string): void {
  if (state.path === path) return
  setState({ path })
}

/** 注入的样式表 id（幂等守卫）。 */
const STYLE_ID = 'deepc-link-file-viewer-css'
const CSS = `
.__dcb_fv-mask{position:fixed;inset:0;z-index:2147483490;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(2,8,24,.55))}
.__dcb_fv-dialog{width:min(720px,94vw);height:min(520px,86vh);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#10141d);border:1px solid var(--dsw-alias-border-l3,rgba(148,163,184,.18));border-radius:14px;box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(2,8,24,.7));color:var(--dsw-alias-label-primary,#e6ebf2)}
.__dcb_fv-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.14))}
.__dcb_fv-title{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.__dcb_fv-path{flex:none;max-width:45%;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa6b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.__dcb_fv-close{flex:none;cursor:pointer;background:none;border:none;color:var(--dsw-alias-label-tertiary,#9aa6b8);font-size:16px;line-height:1;padding:4px 6px;border-radius:6px}
.__dcb_fv-close:hover{color:var(--dsw-alias-label-primary,#e6ebf2)}
.__dcb_fv-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;font-size:12.5px;line-height:1.7}
.__dcb_fv-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-mono,"SF Mono",Consolas,monospace)}
.__dcb_fv-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-secondary,#cbd5e1);border:1px solid transparent}
.__dcb_fv-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.__dcb_fv-muted{color:var(--dsw-alias-label-tertiary,#9aa6b8)}
.__dcb_fv-err{color:var(--dsw-alias-state-error-primary,#fb7185)}
`

let styleInjected = false
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

/** 目录/文本/二进制预览体。 */
function PreviewBody({ path, view }: { path: string; view: FilePreview | null }): React.ReactElement {
  const { t } = useTranslation()
  if (view === null) return React.createElement('div', { className: '__dcb_fv-muted' }, t('file.loading'))
  if (!view.ok) {
    return React.createElement('div', { className: '__dcb_fv-err' }, view.error ?? t('file.readFailed'))
  }
  if (view.kind === 'directory' && view.listing) {
    const entries = view.listing.entries
    return React.createElement(
      'div',
      null,
      React.createElement(
        'button',
        {
          className: '__dcb_fv-row',
          style: { background: 'none', border: 'none', width: '100%', textAlign: 'left' },
          onClick: () => {
            const parent = view.listing!.path.replace(/[\\/][^\\/]*[\\/]?$/, '')
            if (parent && parent !== view.listing!.path) openFilePreview(parent)
          },
        },
        '⬆ ..',
      ),
      entries.length === 0
        ? React.createElement('div', { className: '__dcb_fv-muted' }, t('file.empty'))
        : entries.map((en) =>
            React.createElement(
              'div',
              {
                key: en.path,
                className: '__dcb_fv-row',
                onClick: () => openFilePreview(en.path),
              },
              React.createElement('span', null, '📁 ' + en.name),
            ),
          ),
    )
  }
  if (view.kind === 'text') {
    return React.createElement('pre', { className: '__dcb_fv-pre' }, view.text ?? '')
  }
  // binary：提示 + 路径
  return React.createElement(
    'div',
    { className: '__dcb_fv-muted' },
    t('file.binaryHint'),
    view.ext ? '.' + view.ext + '，' : '',
    Math.max(1, Math.round((view.size ?? 0) / 1024)),
    t('file.kb'),
    React.createElement('div', { style: { marginTop: 8 } }, t('file.path'), path),
  )
}

/** 查看器 modal 组件（挂到 body，路径非空时渲染）。 */
function FileViewer(): React.ReactElement | null {
  const { t } = useTranslation()
  const snap = React.useSyncExternalStore(subscribe, getSnapshot)
  const [view, setView] = React.useState<FilePreview | null>(null)
  const path = snap.path

  React.useEffect(() => {
    let cancelled = false
    // 宏任务：避免 effect 同步路径 setView(null)（React Compiler set-state-in-effect）
    const id = window.setTimeout(() => {
      if (cancelled) return
      if (!path) {
        setView(null)
        return
      }
      setView(null)
      fetch(`/deepc/read-file?path=${encodeURIComponent(path)}`)
        .then((r) => r.json() as Promise<FilePreview>)
        .then((v) => {
          if (!cancelled) setView(v)
        })
        .catch(() => {
          if (!cancelled) setView({ ok: false, error: t('file.networkError') })
        })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [path, t])

  if (!path) return null
  const close = (): void => setState({ path: null })
  return React.createElement(
    'div',
    { className: '__dcb_fv-mask', onClick: (e: React.MouseEvent) => { if (e.target === e.currentTarget) close() } },
    React.createElement(
      'div',
      { className: '__dcb_fv-dialog' },
      React.createElement(
        'div',
        { className: '__dcb_fv-head' },
        React.createElement('span', { className: '__dcb_fv-title' }, view?.name ?? path.replace(/^.*[\\/]/, '')),
        React.createElement('span', { className: '__dcb_fv-path', title: path }, path),
        React.createElement('button', { className: '__dcb_fv-close', title: t('file.close'), onClick: close }, '✕'),
      ),
      React.createElement('div', { className: '__dcb_fv-body' }, React.createElement(PreviewBody, { path, view })),
    ),
  )
}

let mounted = false

/** 挂载 viewer modal 到 body（幂等；样式注入 + createRoot 渲染 + 状态订阅）。 */
export function installFileViewer(): void {
  if (mounted || typeof document === 'undefined') return
  mounted = true
  ensureStyle()
  const mount = document.createElement('div')
  mount.id = 'deepc-link-file-viewer'
  document.body.appendChild(mount)
  const root = createRoot(mount)
  const render = (): void => root.render(React.createElement(FileViewer))
  render()
  // viewer 状态变化时重渲染
  subscribe(render)
}
