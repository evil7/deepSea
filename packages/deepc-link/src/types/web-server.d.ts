/**
 * dsh host 注入的 webServer 服务类型增强（deepc-link 声明的本地模块扩展）。
 *
 * dsh host 的 `@deepseek-ai/dsh-host-webserver` 插件通过 `declare module` 把
 * `ctx.webServer` 注入 cordis Context。deepc-link 单独作为包编译时看不到该
 * 增强，故此处声明兼容的最小接口，仅供 `index.ts` 的 `apply(ctx)` 注册 /deepc
 * 路由使用。
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
  }
}

export {}
