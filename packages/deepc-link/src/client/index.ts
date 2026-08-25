/**
 * deepc-link browser 端插件 —— 跑在本地 dsh 前端（浏览器）。
 *
 * 经 dsh 的 `dsh.client` 声明 + `exports["./client"]` 被 `dsh-client-modules`
 * 发现，注入 `__DSH_BOOT__` entry graph，随官方前端一起 boot。
 *
 * apply 里注入「deepSea 互联」悬浮球（右下角 deepSea 图标）+ 卡片式 Sheet：
 *   · header：`(deepc logo) deepSea` + 登录按钮（登录后显示头像）
 *   · body：配置同步 + 多端直连状态（纯展示，经 /deepc/* 调 node 后端）
 *
 * 注意：browser 端的 entry id 由 `window.__ModuleLoader__.load({ id })` 提供
 * （= package name `deepc-link`），此处 `name` 仅作客户端 cordis runtime
 * 的服务名，不参与 entry 发现。
 */

import { bootstrapHostUi } from '../host-ui'

export const name = 'deepc-link'

export const inject: string[] = []

// 注意：远端目录选择器的浏览器内 UI（src/client/directory-picker.ts）暂未启用。
// 它 register 进 dsh 的 conversation.hero.workspace.directoryFlow 单席位 slot 时，
// 会与官方 dsh-client-ui-directory-picker-native 在同一 priority 0 冲突，触发
// "single slot already has a registration" → 前端 "Failed to load plugins"。
// 根因与后续方案见 docs/deepsea-deepc-directory-picker-slot-conflict.md。

export function apply(_ctx: unknown): void {
  bootstrapHostUi()
}
