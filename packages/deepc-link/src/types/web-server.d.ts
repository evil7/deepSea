/**
 * dsh host 注入的 webServer / apiProxy 服务类型增强（deepc-link 声明的本地模块扩展）。
 *
 * dsh host 的 `@deepseek-ai/dsh-host-webserver` 插件通过 `declare module` 把
 * `ctx.webServer` 注入 cordis Context；`@deepseek-ai/dsh-host-apiproxy` 把
 * `ctx.apiProxy` 注入（`ApiProxyService extends Service`，`super(ctx,"apiProxy")`）。
 * deepc-link 单独作为包编译时看不到这些增强，故此处声明兼容的最小接口：
 *   · webServer —— /deepc 路由注册
 *   · apiProxy  —— 数据面桥本地端点（域树 session/workspace/host/settings/events/…）
 * apiProxy 用 `unknown` 而非强依赖 dsh-host-apiproxy 类型包；运行时由 cordis 注入，
 * 具体结构由 `local-api.ts` 的 `ApiProxyLocalApi` 以 any 落地。
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
    }
    /** dsh 官方 API 网关域树（dsh-host-apiproxy 提供）；数据面桥的唯一本地端点。 */
    apiProxy: unknown
  }
}

export {}
