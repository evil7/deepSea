/**
 * dsh host 注入的 webServer 服务类型增强（deepc-link 声明的本地模块扩展）。
 *
 * dsh host 的 `@deepseek-ai/dsh-host-webserver` 插件通过 `declare module` 把
 * `ctx.webServer` 注入 cordis Context。deepc-link 单独作为包编译时看不到这些增强，
 * 故此处声明兼容的最小接口：webServer —— /deepc 路由注册。
 *
 * ⚠️ 官方调研结论（2026-08-26，见 docs/deepsea-tunnel-bridge-proposal.md）：
 *   `WebServer` 完整 API 为 register / registerUpgrade / registerFallback / tapIndex /
 *   collectIndexInjections / renderIndex / applyIndexTaps / port / host ——
 *   **无全局中间件**。fallback 单席位已被 `dsh-host-frontend-static` 占用（二次注册抛错），
 *   host 只允许 127.0.0.1 / 0.0.0.0 且 CLI 拒绝 0.0.0.0（官方安全立场）。
 *   → 远端鉴权不能靠注入官方 webServer，必须用**独立 3081 代理**（auth-proxy.ts）。
 *
 * 注：旧 apiProxy 类型增强已随 P2P 数据面桥退役删除。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

declare module '@deepseek-ai/cordis' {
  interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }

  interface Context {
    webServer: {
      register: (route: WebRoute) => () => void
      /** 单 fallback 席位（已被 frontend-static 占用，勿二次注册）。 */
      registerFallback?: (handler: WebRoute['handler']) => () => void
      /** index.html 转换（仅前端注入用，不能做 HTTP 鉴权）。 */
      tapIndex?: (transform: (html: string) => string) => () => void
      /** 监听端口（OS 分配时读实际值）。 */
      readonly port: number
      /** 绑定地址：'127.0.0.1' | '0.0.0.0'。 */
      readonly host: '127.0.0.1' | '0.0.0.0'
    }
  }
}

export {}
