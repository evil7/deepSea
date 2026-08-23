/**
 * deepc-link 本地 API 处理器抽象（多端互联的本地端点）。
 *
 * 定位：把「远端 chatUI 经 DataChannel 发来的 API 调用」落到本地 dsh host。
 * 抽象 `LocalApi` 接口，使实现可替换：
 *   · `HttpLocalApi`（当前）：HTTP fetch unary + WS 订阅下行流，访问本地 dsh host
 *     （127.0.0.1:3080）。node 端无浏览器同源/CORS 限制，可直接访问。
 *   · 未来：`toFetchHandler(ctx.apiProxy)` 直连官方 API 网关（InProcessApiClient 变体），
 *     零网络。届时仅替换实现，api-bridge 调用方不变。
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
