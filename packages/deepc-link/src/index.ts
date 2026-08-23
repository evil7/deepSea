import type { Context } from '@deepseek-ai/cordis'

import { installRtcPolyfill } from './polyfill'
import { createNodeHost, type NodeHost, NODE_CTRL_PATH } from './node-host'

/**
 * deepc-link node 端插件 —— 连接层 + 逻辑层（前端只做展示）。
 *
 * node 端跑在 dsh host 的 Node 进程内（headless），用 node-datachannel 提供
 * 与浏览器对齐的 WebRTC 端点。模块加载即注入 polyfill 全局，使 session.ts
 * 的浏览器风格 WebRTC 代码在 node 端直接运行（零改动复用）。
 *
 * node-host 在此启动：
 *   · Device Grant 登录（生成 state → 轮询换 token）
 *   · 设备注册 + 心跳
 *   · WS 信令（被动接收主站 offer）
 *   · deepc.* 能力（os.hostname / fs.listDirectories）
 *   · 经 ctx.webServer 注册 /deepc 前缀路由承载前端控制（同源、免 CORS）
 *
 * 所有注册都必须作为可回滚 effect（fiber dispose 时还原），保证零残留。
 */

// 模块加载即注入 headless WebRTC 端点（须早于任何 session.ts 会话 API 调用）。
installRtcPolyfill()

export const name = 'deepc-link'

/** node-host 单例（apply 可能被重复调用，防重复起连接层）。 */
let nodeHost: NodeHost | null = null

/** 声明依赖 webServer：等它可用才启动本插件（避免 ctx.webServer 启动时为 undefined）。 */
export const inject = ['webServer']

export function apply(ctx: Context): void {
  if (nodeHost) return
  const host = createNodeHost()
  nodeHost = host
  // 注册 /deepc 前缀路由承载前端控制（同源，复用 dsh 3080，免 CORS）。
  // ctx.effect 的 disposer = register 的返回函数，fiber 卸载自动撤销路由。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: NODE_CTRL_PATH,
      handler: (req, res) => void host.handleControl(req, res),
    })
  )
  // 启动即尝试恢复既有登录（有持久 token → 自动注册/心跳/信令；无则保持未登录）。
  void host.restore()
  // host 非 HTTP 资源（RTC/心跳）随 fiber 卸载清理。
  ctx.effect(() => {
    return () => {
      host.dispose()
      if (nodeHost === host) nodeHost = null
    }
  })
}

// 对外暴露「多端直连信令」（nodeId 寻址 + 收件人 nodeId 派生密钥 + WS 推送）。
export { respondMailboxOffer } from './session'
export type {
  ClientSession,
  SessionOptions,
  MailboxAnswer,
} from './session'

// 对外暴露「信箱信封编解码」（offer/answer 跨端契约）。
export { encodeEnvelope, decodeEnvelope } from './node-signaling'
export type { MailboxEnvelope, MailboxKind } from './node-signaling'

// 对外暴露「多端直连信令基址」（与主站同源；dev 走 vite 代理，prod deepc.cn）。
export { DEFAULT_SIGNAL_BASE as NODE_SIGNAL_BASE } from './device-auth'

// 对外暴露「多端互联」数据面桥能力（S2：DataChannel 帧 → 本地 API）。
export { installApiBridge } from './api-bridge'
export type { ApiBridge } from './api-bridge'
export { HttpLocalApi, DEFAULT_HOST_BASE } from './local-api'
export type { LocalApi } from './local-api'

// 对外暴露「基础信息对齐」握手能力（S2：hello 推送 host/theme/model）。
export { installHostHandshake } from './host-handshake'
export type { HostHandshake } from './host-handshake'
export { PROTOCOL_VERSION } from './protocol'
export type { HostInfo, ModelSelection } from './protocol'
