/**
 * deepc-link 本地 API 处理器抽象（多端互联的本地端点）。
 *
 * 定位：把「远端 chatUI 经 DataChannel 发来的 API 调用」落到本地 dsh host。
 * 抽象 `LocalApi` 接口，使实现可替换：
 *   · `ApiProxyLocalApi`（推荐）：经 ctx.apiProxy 直连官方 API 网关，零网络。
 *     插件作为 cordis 插件天然持有 ctx.apiProxy，无需绕 HTTP 回环。
 *   · `HttpLocalApi`（降级/兼容）：HTTP fetch unary + WS 订阅下行流，访问本地 dsh host
 *     （127.0.0.1:3080）。适用于 apiProxy 不可用或需走非标准 HTTP 路由的场景。
 *
 * 正统插件开发标准：优先使用 ApiProxyLocalApi（ctx.apiProxy 直连），
 * 仅对 apiProxy 域树不覆盖的方法（如 pluginInventory/list）回退到 HttpLocalApi。
 */

import type { RpcResult, ServerRequest, ServerResponse, StreamKind } from './protocol'

/** 本地 dsh host 默认基址（dsh web 默认 127.0.0.1:3080）。 */
export const DEFAULT_HOST_BASE = 'http://127.0.0.1:3080'

/**
 * 本地 API 处理器接口：上行 unary + 下行流订阅。
 * 语义对齐 dsh 四象限信封（client-request → server-response / server-request）。
 */
export interface LocalApi {
  /** 上行 unary：调本地 dsh API，返回 server-response 的 result。 */
  callUnary(method: string, payload: unknown): Promise<RpcResult>
  /** 订阅下行流（events.mux / events.host），返回取消函数。 */
  subscribe(stream: StreamKind, onFrame: (env: ServerRequest) => void): () => void
}

/** 生成唯一 id（rpcId / subId）。 */
function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * HTTP 实现：fetch 上行 unary + 原生 WebSocket 订阅下行流。
 * 适用于 node 端（无浏览器同源限制，node 24 提供全局 WebSocket）。
 */
export class HttpLocalApi implements LocalApi {
  private readonly httpBase: string
  private readonly wsBase: string

  constructor(baseUrl: string = DEFAULT_HOST_BASE) {
    const trimmed = baseUrl.replace(/\/+$/, '')
    this.httpBase = trimmed
    this.wsBase = trimmed.replace(/^http/, 'ws')
  }

  async callUnary(method: string, payload: unknown): Promise<RpcResult> {
    const rpcId = uid('rpc')
    const request = { type: 'client-request', rpcId, method, payload }
    try {
      const res = await fetch(`${this.httpBase}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!res.ok) {
        return {
          ok: false,
          error: { code: 'http-error', message: `HTTP ${res.status}` },
        }
      }
      const serverResponse = (await res.json()) as ServerResponse
      return serverResponse.result
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'network-error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  subscribe(stream: StreamKind, onFrame: (env: ServerRequest) => void): () => void {
    const ws = new WebSocket(`${this.wsBase}/api/events.${stream}`)
    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const env = JSON.parse(String(event.data)) as ServerRequest
        onFrame(env)
      } catch {
        // 非 JSON 帧忽略（dsh 下行均为 JSON server-request）
      }
    })
    return () => {
      ws.close()
    }
  }
}

// ---------------------------------------------------------------------------
// ApiProxyLocalApi —— 官方 cordis 插件正统实现（ctx.apiProxy 直连，零网络）
// ---------------------------------------------------------------------------

/**
 * HTTP 路径域名 → apiProxy 域树键 映射。
 *
 * dsh HTTP gateway（toFetchHandler）内部做 `session.*` → `sessions.*` 的重映射；
 * 直连 apiProxy 时需显式声明。未列入的域名（workspace/settings/host 等）同名直通。
 */
const DOMAIN_MAP: Record<string, string> = {
  session: 'sessions',
  subagent: 'subagents',
}

/**
 * apiProxy 域树不覆盖的方法集合（pluginInventory/list 等自定义 HTTP 路由）。
 * 这些方法必须回退到 HttpLocalApi 走 HTTP 回环。
 */
const HTTP_ONLY_METHODS = new Set([
  'pluginInventory/list',
  'messageFeedback.put',
])

/**
 * apiProxy 直连实现：经 cordis ctx.apiProxy 域树直接调用，零网络。
 *
 * 设计：
 *   · 标准 apiProxy 方法（session/workspace/settings/host/llm 等）→ 直连 ctx.apiProxy
 *   · 非标准 HTTP-only 方法（pluginInventory/list 等）→ 回退 HttpLocalApi
 *   · 下行流订阅（events.mux / events.host）→ 回退 HttpLocalApi（WS 方式更成熟可靠）
 *
 * 入参 apiProxy 类型为 any（避免强依赖 @deepseek-ai/dsh-host-apiproxy 类型包），
 * 运行时由 cordis 注入，类型安全由调用方保证。
 */
export class ApiProxyLocalApi implements LocalApi {
  private readonly apiProxy: any
  private readonly httpFallback: HttpLocalApi

  constructor(apiProxy: any, hostBase: string = DEFAULT_HOST_BASE) {
    this.apiProxy = apiProxy
    this.httpFallback = new HttpLocalApi(hostBase)
  }

  async callUnary(method: string, payload: unknown): Promise<RpcResult> {
    // 非标准方法：回退 HTTP（apiProxy 域树不覆盖）。
    if (HTTP_ONLY_METHODS.has(method)) {
      return this.httpFallback.callUnary(method, payload)
    }

    // 解析 method → domain + action（如 "session.list" → domain="session", action="list"）。
    const dotIdx = method.lastIndexOf('.')
    if (dotIdx < 0) {
      return { ok: false, error: { code: 'bad-method', message: `方法名缺少域分隔符: ${method}` } }
    }
    const domain = method.slice(0, dotIdx)
    const action = method.slice(dotIdx + 1)

    // 域名映射（HTTP 路径名 → apiProxy 域树键）。
    const treeKey = DOMAIN_MAP[domain] ?? domain
    const domainObj = this.apiProxy?.[treeKey]

    if (!domainObj || typeof domainObj[action] !== 'function') {
      // apiProxy 无此方法：回退 HTTP（兜底兼容）。
      return this.httpFallback.callUnary(method, payload)
    }

    try {
      // apiProxy 域方法接收 RpcRequest 信封（需 rpcId + payload 字段）。
      // 与 toFetchHandler 信封对齐：domainObj[action]({ rpcId, ...payloadFields })。
      const rpcId = uid('rpc')
      const request = { rpcId, ...(payload as Record<string, unknown> ?? {}) }
      const result = await domainObj[action](request)
      return { ok: true, value: result }
    } catch (error) {
      // apiProxy 调用失败：回退 HTTP（兜底兼容，避免 apiProxy 签名不匹配时全挂）。
      return this.httpFallback.callUnary(method, payload)
    }
  }

  subscribe(stream: StreamKind, onFrame: (env: ServerRequest) => void): () => void {
    // 下行流订阅回退 HTTP WS（apiProxy AsyncIterable API 尚不成熟，WS 更可靠）。
    return this.httpFallback.subscribe(stream, onFrame)
  }
}
