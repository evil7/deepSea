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

/**
 * browser 端 apply：注入「deepc 互联」悬浮球 + Sheet 侧栏。
 * deepc-link 不依赖任何 dsh 服务（纯 WebRTC + fetch 桥），故不声明 inject。
 */
export function apply(_ctx: unknown): void {
  bootstrapHostUi()
}
