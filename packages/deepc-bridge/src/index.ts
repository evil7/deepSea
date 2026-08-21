import type { Context } from '@deepseek-ai/cordis'

import { installRtcPolyfill } from './polyfill'

/**
 * deepc-bridge node 端插件 —— deepc-sonar-bridge 底座 + 两大功能。
 *
 * node 端跑在 dsh host 的 Node 进程内（headless），用 node-datachannel 提供
 * 与浏览器对齐的 WebRTC 端点。模块加载即注入 polyfill 全局，使 session.ts
 * 的浏览器风格 WebRTC 代码在 node 端直接运行（零改动复用）。
 *
 * 后续阶段在此注入能力：
 * - `ctx.apiProxy`：dsh 本地功能网关，经 toFetchHandler 变成本地 API 处理器
 *   （操作互联的本地端点）
 * - fs.watch：工作区变更检测（工程同步的增量来源）
 *
 * 所有注册都必须作为可回滚 effect（fiber dispose 时还原），保证零残留。
 */

// 模块加载即注入 headless WebRTC 端点（须早于任何 session.ts 会话 API 调用）。
installRtcPolyfill()

export const name = 'deepc-bridge'

export function apply(_ctx: Context): void {
  // S1：底座已就绪（node-datachannel headless 端点已注入全局）。
  // 后续阶段在此暴露 host 会话能力并接入 ctx.apiProxy。
}

// 对外暴露 host 会话能力（deepc-sonar-bridge 底座：配对 + 信令 + DC 建立）。
export { createHostOffer, finalizeHost, startHostSession } from './session'
export type { HostOffer, HostSession, SessionOptions } from './session'

// 对外暴露「操作互联」数据面桥能力（S2：DataChannel 帧 → 本地 API）。
export { installApiBridge } from './api-bridge'
export type { ApiBridge } from './api-bridge'
export { HttpLocalApi, DEFAULT_HOST_BASE } from './local-api'
export type { LocalApi } from './local-api'

// 对外暴露「基础信息对齐」握手能力（S2：hello 推送 host/theme/model）。
export { installHostHandshake } from './host-handshake'
export type { HostHandshake } from './host-handshake'
export { PROTOCOL_VERSION } from './protocol'
export type { HostInfo, ModelSelection } from './protocol'
