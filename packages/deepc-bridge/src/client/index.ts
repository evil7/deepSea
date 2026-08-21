/**
 * deepc-bridge browser 端插件 —— 跑在本地 dsh 前端（浏览器）。
 *
 * 经 dsh 的 `dsh.client` 声明 + `exports["./client"]` 被 `dsh-client-modules`
 * 发现，注入 `__DSH_BOOT__` entry graph，随官方前端一起 boot。
 *
 * S0 骨架：不注入任何 UI。后续阶段在此接入：
 *   - 操作互联：自实现 chatUI 的引导入口（WebRtcApiClient）
 *   - 工程同步：工作区 + 聊天记录的增量传输入口
 *
 * 注意：browser 端的 entry id 由 `window.__ModuleLoader__.load({ id })` 提供
 * （= package name `@deepsea/deepc-bridge`），此处 `name` 仅作客户端 cordis runtime
 * 的服务名，不参与 entry 发现。
 */

export const name = 'deepc-bridge'

/**
 * browser 端 apply：操作互联 chatUI 引导 + 工程同步入口（S0 骨架）。
 * deepc-bridge 不依赖任何 dsh 服务（纯 WebRTC + fetch 桥），故不声明 inject。
 */
export function apply(_ctx: unknown): void {
  // S0：仅证明 bundle 可挂载。后续阶段填充 chatUI 引导 + 工程同步。
}
