import type { Context } from '@deepseek-ai/cordis'

import { createDeepcHost, type DeepcHost, NODE_CTRL_PATH } from './host'

/**
 * deepc-link 插件 —— 壳：三模式互联 + TOTP 2FA + 3081 鉴权代理 + cloudflared 托管。
 *
 * 运行在 dsh host 的 Node 进程内（headless）。不再依赖 node-datachannel / WebRTC。
 * 三种互联模式（用户自选，见 docs/deepsea-tunnel-bridge-proposal.md）：
 *   1. local   本地域内共享（3081 TOTP 2FA，局域网访问）
 *   2. tunnel  CF Tunnel 暴露（cloudflared：匿名 Quick Tunnel / 自定义域）
 *   3. managed 主站纳管（Device Grant 登录 + 上报 URL，断链自动重连上报）
 *
 * 职责：
 *   · TOTP secret 持久化（~/.deepc）+ 注入 3081 鉴权代理（反代 3080 + WS 透传）
 *   · Device Grant 登录（managed 模式）
 *   · 托管 cloudflared 子进程（GitHub Release 下载 + SHA-256 校验）
 *   · DO 事件订阅（managed 模式：node_deleted → 停本地）
 *   · 经 ctx.webServer 注册 /deepc 前缀路由承载前端控制（同源、免 CORS）
 */

export const name = 'deepc-link'

/** host 单例（apply 可能被重复调用，防重复起连接层）。 */
let deepcHost: DeepcHost | null = null

/**
 * 声明硬依赖：webServer —— /deepc 前缀路由注册（同机凭证传递）。
 * 不再依赖 apiProxy（P2P 数据面桥已退役）。
 */
export const inject = ['webServer']

export function apply(ctx: Context): void {
  if (deepcHost) return
  const host = createDeepcHost()
  deepcHost = host
  // 注册 /deepc 前缀路由承载前端控制（同源，复用 dsh 3080，免 CORS）。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: NODE_CTRL_PATH,
      handler: (req, res) => void host.handleControl(req, res),
    })
  )
  // 启动即尝试恢复既有登录（有持久 token → 自动 connect；无则保持未登录）。
  void host.restore()
  // host 非 HTTP 资源（cloudflared 子进程 / 3081 / DO WS）随 fiber 卸载清理。
  ctx.effect(() => {
    return () => {
      host.dispose()
      if (deepcHost === host) deepcHost = null
    }
  })
}

