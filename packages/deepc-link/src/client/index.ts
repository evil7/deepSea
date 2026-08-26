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
import { registerBrowseDirectoryPicker, type SlotsCtx } from './directory-picker'

export const name = 'deepc-link'

/** 依赖 slots 服务（目录流 shadow 用）；ui-workspace 的加载顺序由 package.json dsh.client.inject 保证。 */
export const inject: string[] = ['slots']

export function apply(ctx: SlotsCtx): void {
  bootstrapHostUi()
  // 全面替换 dsh 原生 OS 目录选择器：本地 + 远端统一浏览器内目录浏览（priority -1 shadow native）。
  registerBrowseDirectoryPicker(ctx)
}
