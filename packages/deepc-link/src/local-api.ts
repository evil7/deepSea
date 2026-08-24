/**
 * deepc-link 本地 API 处理器 —— 数据面桥的「本地端点」唯一实现。
 *
 * 定位：把「远端 chatUI 经 DataChannel 发来的 API 调用」落到本地 dsh host 的
 * **官方 apiProxy 域树**。这是 dsh 官方留给插件的正统 seam（见
 * `docs/deepsea-cordis-plugin-consensus.md` §4 / `dsh-host-apiproxy`）：
 *
 *   · unary（`session.list` / `workspace.list` / `host.describe` …）→ 直连
 *     `apiProxy.<domain>.<action>({ rpcId, payload })`，窄形 `RpcRequest` 信封。
 *   · 下行流（`events.mux` / `events.host`）→ `apiProxy.events.<stream>(request,
 *     signal)` 返回 `AsyncIterable<RpcRequest<Frame>>`，`for await` 消费后包装成
 *     `ServerRequest`（`method = frame.type`，对齐官方 `toFetchHandler` 的 fullFrame）。
 *
 * 官方契约（`dsh-host-apiproxy/lib/types`）：
 *   - `RpcRequest<P> = { rpcId: RpcId, payload: P }`（窄形，rpcId 显式、绝不混入 payload）
 *   - `RpcResponse<T> = { rpcId, result: RpcResult<T> }`（rpcId 回显）
 *   - `ApiProxy.events.mux/host(request, signal)` → `AsyncIterable<RpcRequest<MuxFrame|HostFrame>>`
 *
 * 不设任何 HTTP 回环 / 降级兜底：apiProxy 域树之外的方法（`commands` / `pluginInventory`
 * 等 typert Remote）由 `deepc-api.ts` 经 host 侧 cordis service 直连，不落本模块。
 */

import type { RpcResult, ServerRequest, StreamKind } from './protocol'

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
 * HTTP 路径域名 → apiProxy 域树键 映射（对齐官方 `toFetchHandler` 的域重映射）。
 * 官方 gateway 把 `session.*` → `sessions.*`、`subagent.*` → `subagents.*`；
 * 直连 apiProxy 时需显式声明。未列入的域名（workspace/settings/host/skills/
 * agentPresets/goals/credentials/llm）在 apiProxy 域树中同名直通。
 */
const DOMAIN_MAP: Record<string, string> = {
  session: 'sessions',
  subagent: 'subagents',
}

/**
 * apiProxy 直连实现（唯一）：经 cordis ctx.apiProxy 域树直接调用，零网络、零兜底。
 *
 * 入参 apiProxy 类型为 any（避免强依赖 @deepseek-ai/dsh-host-apiproxy 类型包），
 * 运行时由 cordis 注入。方法名遵循官方 wire 路径（点号 `session.list`），
 * 本模块负责把它落到 `apiProxy.sessions.list` 的窄形 RpcRequest 信封。
 */
export class ApiProxyLocalApi implements LocalApi {
  private readonly apiProxy: any

  constructor(apiProxy: any) {
    this.apiProxy = apiProxy
  }

  async callUnary(method: string, payload: unknown): Promise<RpcResult> {
    // 解析 method → domain + action（如 "session.list" → domain="session", action="list"）。
    const dotIdx = method.lastIndexOf('.')
    if (dotIdx < 0) {
      return { ok: false, error: { code: 'bad-method', message: `方法名缺少域分隔符: ${method}` } }
    }
    const domain = method.slice(0, dotIdx)
    const action = method.slice(dotIdx + 1)

    // 域名映射（HTTP 路径名 → apiProxy 域树键）。
    const treeKey = DOMAIN_MAP[domain] ?? domain
    const fn = this.apiProxy?.[treeKey]?.[action]

    if (typeof fn !== 'function') {
      // 域树无此方法：直接报错（不降级）。apiProxy 是 dsh 官方 API 的封闭契约，
      // 方法缺失说明调用方传了非官方 method（应由 deepc-api 层拦截转 host service）。
      return { ok: false, error: { code: 'method-not-found', message: method } }
    }

    // 官方窄形信封：RpcRequest<P> = { rpcId, payload }。绝不用展开形混入 payload。
    const rpcId = uid('rpc')
    const response = await fn({ rpcId, payload })
    // RpcResponse<T> = { rpcId, result }。取 result 直接返回（对齐 server-response）。
    return (response?.result ?? {
      ok: false,
      error: { code: 'internal', message: `apiProxy 返回异常: ${method}` },
    }) as RpcResult
  }

  subscribe(stream: StreamKind, onFrame: (env: ServerRequest) => void): () => void {
    // 官方下行流：apiProxy.events.<stream>(request, signal) → AsyncIterable。
    const controller = new AbortController()
    const request = { rpcId: uid('rpc'), payload: {} }
    const events = this.apiProxy?.events
    const opener =
      stream === 'mux' ? events?.mux?.bind(events) : events?.host?.bind(events)

    if (typeof opener !== 'function') {
      // events 域树缺失：无下行流可订阅，返回 no-op 取消函数。
      return () => {}
    }

    const iter = opener(request, controller.signal) as AsyncIterable<{
      rpcId: string
      payload: { type: string }
    }>

    void (async () => {
      try {
        for await (const narrow of iter) {
          // 对齐官方 fullFrame：ServerRequest 的 method = frame.type，payload = 整帧。
          const envelope: ServerRequest = {
            type: 'server-request',
            rpcId: narrow.rpcId,
            method: narrow.payload.type,
            payload: narrow.payload,
          }
          onFrame(envelope)
        }
      } catch {
        // 流被 abort / 异常结束：静默（连接生命周期由上层 bridge 管理）。
      }
    })()

    return () => controller.abort()
  }
}
