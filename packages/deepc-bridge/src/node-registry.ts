/**
 * deepc-bridge 插件后端设备注册 + 心跳 —— 多端直连的设备身份底座（node 端专属）。
 *
 * 插件后端登录（node-host 轮询 Device Grant 换取 device_token）后，经本模块：
 *   · nodeId 由 hostname 派生（node-host 传入，同主机 = 同 ID）
 *   · POST /auth/node/register 注册设备（Authorization: Bearer device_token）
 *   · 定时 POST /auth/node/heartbeat 心跳续期（保持 online 状态）
 *   · 登出/销毁时停止心跳
 *
 * 设备归属由 device_token 关联的 github_id 判定（worker 端校验）。
 */

/** 构建时由 esbuild `--define` 注入的 Worker/信令基址（见 scripts/build.mjs）。 */
declare const __DEEPC_SIGNAL_BASE__: string

/** 心跳间隔（毫秒，默认 30s，worker 在线阈值 90s 内可覆盖 2 次心跳）。 */
const HEARTBEAT_INTERVAL_MS = 30_000

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
  /** 注册 + 启动心跳；返回注册结果（quota-exceeded 时**不**启动心跳）。 */
  start: () => Promise<RegisterOutcome>
  /** 立即心跳一次（注册后 / 恢复连接时用）。 */
  heartbeatNow: () => Promise<boolean>
  /** 停止心跳（登出 / 销毁）。 */
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

/** 创建节点注册器（懒启动，start() 时才解析 nodeId + 注册 + 心跳）。 */
export function createNodeRegistry(
  opts: NodeRegistryOptions
): NodeRegistry {
  const signalBase = opts.signalBase ?? __DEEPC_SIGNAL_BASE__

  // nodeId 由 node 端经 opts.nodeId（hostname 派生）注入；start() 时落位。
  let nodeId = ''
  let name = opts.name ?? defaultName()

  let timer: ReturnType<typeof setInterval> | null = null

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

  async function heartbeat(): Promise<boolean> {
    const token = opts.token
    if (!token) return false
    const res = await authFetch<{ ok?: boolean }>(signalBase, '/auth/node/heartbeat', token, {
      nodeId,
    })
    return res?.ok === true
  }

  return {
    get nodeId() { return nodeId },
    start: async (): Promise<RegisterOutcome> => {
      nodeId = opts.nodeId

      const outcome = await register()
      if (outcome !== 'ok') return outcome
      await heartbeat()
      // 启动连续心跳前清理历史 timer（防重复 start() 叠加）；stop() 方法在下方返回对象。
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        void heartbeat()
      }, HEARTBEAT_INTERVAL_MS)
      return 'ok'
    },
    heartbeatNow: heartbeat,
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
