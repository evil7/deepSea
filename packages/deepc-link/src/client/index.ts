/**
 * deepc-link browser 端插件 —— 跑在本地 dsh 前端（浏览器）。
 *
 * 经 dsh 的 `dsh.client` 声明 + `exports["./client"]` 被 `dsh-client-modules`
 * 发现，注入 `__DSH_BOOT__` entry graph，随官方前端一起 boot。
 *
 * apply 里：
 *   1) 安装 monkey-patch 统一介入层（远端能力接管：settings mirror / 目录选择器等）；
 *   2) 注入「deepSea 互联」悬浮球（右下角 deepSea 图标）+ 卡片式 Sheet。
 *
 * 注意：browser 端的 entry id 由 `window.__ModuleLoader__.load({ id })` 提供
 * （= package name `deepc-link`），此处 `name` 仅作客户端 cordis runtime
 * 的服务名，不参与 entry 发现。
 */

import { bootstrapHostUi } from './host-ui'
import { installMonkeyPatches, type MonkeyPatchCtx } from './monkey-patch'

export const name = 'deepc-link'

/**
 * 依赖：slots（目录流 shadow）、connection（覆盖 isLoopback）、settingsScope（切换 mirror）。
 * 声明 settingsScope 依赖确保 apply 在 dsh-client-ui-settings 提供 mirror 之后执行，
 * 从而能拿到并纠正 mirror 的持久化模式。
 */
export const inject: string[] = ['slots', 'connection', 'settingsScope']

export function apply(ctx: MonkeyPatchCtx): void {
  // monkey-patch 统一介入层：远端能力接管（settings mirror / 目录选择器等）。
  installMonkeyPatches(ctx)
  // deepSea 互联悬浮球 + Sheet（三模式 UI + 2FA 二维码）。
  bootstrapHostUi()
}
