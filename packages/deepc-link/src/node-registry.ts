/**
 * deepc-link 插件后端设备注册 —— 多端直连的设备身份底座（node 端专属）。
 *
 * 插件后端登录（node-host 轮询 Device Grant 换取 device_token）后，经本模块：
 *   · nodeId 由 hostname 派生（node-host 传入，同主机 = 同 ID）
 *   · POST /auth/node/register 注册设备（Authorization: Bearer device_token）
 *
 * 在线状态不再发 HTTP 心跳：由 mailbox-host 的 WS 长连接（/ws/signal DO 信号房）
 * 存活体现，DO 内存态是唯一权威源（0 worker 额度）。
 *
 * 设备归属由 device_token 关联的 github_id 判定（worker 端校验）。
 */

/** 构建时由 esbuild `--define` 注入的 Worker/信令基址（见 scripts/build.mjs）。 */
declare const __DEEPC_SIGNAL_BASE__: string

export interface NodeRegistryOptions {
  /** worker 服务基址（/auth/node/*）。 */
  signalBase?: string
  /** 本端名称（默认 hostname）。 */
  name?: string
  /** device_token（node 端注入，必填）。 */
  token: string
  /** nodeId（node 端由 hostname 派生，必填）。 */
  nodeId: string
}

/** 注册结果：ok 成功；quota-exceeded 超出纳管限制；error 其他失败。 */
export type RegisterOutcome = "ok" | "quota-exceeded" | "error"

export interface NodeRegistry {
  /** 本设备 nodeId（UUID）。 */
  nodeId: string
  /** 注册设备（在线状态由 mailbox-host 的 WS 长连接 presence 体现）。 */
  start: () => Promise<RegisterOutcome>
  /** 停止（登出 / 销毁）。 */
  stop: () => void
}

/** 本端名称（默认 hostname）。 */
function defaultName(): string {
  return 'dsh-node'
}

/** 带 device_token 的授权 fetch。 */
async function authFetch<T>(
  signalBase: string,
  path: string,
  token: string,
  body?: unknown
): Promise<T | null> {
  if (!token) return null
  try {
    const res = await fetch(`${signalBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** 创建节点注册器（懒启动，start() 时才注册）。 */
export function createNodeRegistry(
  opts: NodeRegistryOptions
): NodeRegistry {
  const signalBase = opts.signalBase ?? __DEEPC_SIGNAL_BASE__

  // nodeId 由 node 端经 opts.nodeId（hostname 派生）注入；start() 时落位。
  let nodeId = ''
  const name = opts.name ?? defaultName()

  async function register(): Promise<RegisterOutcome> {
    const token = opts.token
    if (!token) return 'error'
    const res = await authFetch<{ ok?: boolean; error?: string }>(
      signalBase,
      '/auth/node/register',
      token,
      { nodeId, name }
    )
    if (res?.ok === true) return 'ok'
    return res?.error === 'quota-exceeded' ? 'quota-exceeded' : 'error'
  }

  return {
    get nodeId() { return nodeId },
    start: async (): Promise<RegisterOutcome> => {
      nodeId = opts.nodeId
      return register()
    },
    stop: () => {
      // 在线状态由 mailbox-host 的 WS 连接存活体现；无后台心跳任务需清理。
    },
  }
}
