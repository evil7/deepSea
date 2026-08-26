/**
 * host-ui 原子展示组件（无 JSX，用 React.createElement；tsconfig 无 JSX 配置）。
 */

import * as React from 'react'
import { CHECK_ICON, COPY_ICON } from './icons'
import { FAB_ID } from './constants'
import { copyToClipboard } from './api'

/** 便捷别名：React.createElement。 */
const h = React.createElement

/** 内联 SVG 图标（span 容器承载，颜色由 CSS color 控制）。 */
export function Icon({ svg, className }: { svg: string; className?: string }): React.ReactElement {
  return h('span', {
    className,
    dangerouslySetInnerHTML: { __html: svg },
  })
}

/** 头像（有 avatarUrl 时渲染 img，加载失败/无图时回退首字母）。 */
export function Avatar({
  login,
  avatarUrl,
}: {
  login: string
  avatarUrl: string | null
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)
  const name = login.slice(0, 2).toUpperCase()
  if (avatarUrl && !failed) {
    return h(
      'span',
      { className: 'dcb-user-avatar' },
      h('img', {
        src: avatarUrl,
        alt: login,
        referrerPolicy: 'no-referrer',
        onError: () => setFailed(true),
      }),
    )
  }
  return h('span', { className: 'dcb-user-avatar' }, name)
}

/** 开关（shadcn Switch 语义，受控）。 */
export function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.ReactElement {
  return h(
    'label',
    { className: 'dcb-switch' },
    h('input', {
      type: 'checkbox',
      checked,
      disabled,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked),
    }),
    h('span', { className: 'dcb-track' }),
  )
}

/** 复制图标按钮（复制 → 对勾短暂反馈）。 */
export function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  return h('button', {
    className: 'dcb-sub-copy' + (copied ? ' copied' : ''),
    title: '复制完整地址',
    dangerouslySetInnerHTML: { __html: copied ? CHECK_ICON : COPY_ICON },
    onClick: () => {
      void copyToClipboard(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
    },
  })
}

/** 配置行（label + 副文案[+复制] + 右侧开关）。 */
export function TierRow({
  label,
  sub,
  subTitle,
  copyText,
  checked,
  disabled,
  onChange,
}: {
  label: string
  sub: string
  subTitle?: string
  copyText?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.ReactElement {
  return h(
    'div',
    { className: 'dcb-row' },
    h(
      'div',
      { className: 'dcb-row-main' },
      h('div', { className: 'dcb-row-label' }, label),
      h(
        'div',
        { className: 'dcb-row-sub' },
        h('span', { title: subTitle ?? sub }, sub),
        copyText ? h(CopyButton, { text: copyText }) : null,
      ),
    ),
    h(Switch, { checked, disabled, onChange }),
  )
}

/** 悬浮球按钮（deepSea 品牌图标，forwardRef 供 animejs 操作 DOM）。 */
export const Fab = React.forwardRef<
  HTMLDivElement,
  {
    innerHtml: string
    title: string
    onClick: (e: React.MouseEvent) => void
    onMouseEnter: () => void
    onMouseLeave: () => void
  }
>((props, ref) => {
  return h('div', {
    id: FAB_ID,
    ref,
    title: props.title,
    onClick: props.onClick,
    onMouseEnter: props.onMouseEnter,
    onMouseLeave: props.onMouseLeave,
    dangerouslySetInnerHTML: { __html: props.innerHtml },
  })
})
Fab.displayName = 'Fab'
