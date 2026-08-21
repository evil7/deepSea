/**
 * deepc-bridge 插件端设备注册 + 心跳 —— 多端直连的设备身份底座。
 *
 * 插件端登录（Device Grant 换取 device_token）后，经本模块：
 *   · 生成/复用 nodeId（UUID，localStorage 持久化）
 *   · POST /auth/node/register 注册设备（Authorization: Bearer device_token）
 *   · 定时 POST /auth/node/heartbeat 心跳续期（保持 online 状态）
 *   · 登出/销毁时停止心跳
 *
 * nodeId 一旦生成长期稳定（刷新/重启复用），设备归属由 device_token 关联的
 * github_id 判定（worker 端 resolveActorUserId 校验），非本账号不可操作。
 */

import { generateConnectId } from './crypto'

/** nodeId 本地持久化键。 */
const NODE_ID_KEY = 'deepc.nodeId'

/** 心跳间隔（毫秒，默认 30s，worker 在线阈值 90s 内可覆盖 2 次心跳）。 */
const HEARTBEAT_INTERVAL_MS = 30_000

export interface NodeRegistryOptions {
  /** worker 服务基址（/auth/node/*）。 */
  signalBase?: string
  /** 本端名称（默认 hostname）。 */
  name?: string
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

/** 读取或生成持久化 nodeId。 */
export function getOrCreateNodeId(): string {
  try {
    const existing = localStorage.getItem(NODE_ID_KEY)
    if (existing) return existing
    const id = generateConnectId()
    localStorage.setItem(NODE_ID_KEY, id)
    return id
  } catch {
    // 隐私模式等极端情况：仍返回可用 id，只是不持久化（每次刷新变新设备）。
    return generateConnectId()
  }
}

/** 默认本端名称：hostname（去掉端口/域名）。 */
function defaultName(): string {
  try {
    const host = window.location.hostname
    if (host && host !== '127.0.0.1' && host !== 'localhost') return host
    return 'dsh-node'
  } catch {
    return 'dsh-node'
  }
}

/** 带 device_token 的授权 fetch（token 从 localStorage 读取）。 */
async function authFetch<T>(
  signalBase: string,
  path: string,
  body?: unknown
): Promise<T | null> {
  const token = localStorage.getItem('deepc.deviceToken')
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

/** 创建节点注册器（懒启动，start() 时才注册 + 心跳）。 */
export function createNodeRegistry(
  opts: NodeRegistryOptions = {}
): NodeRegistry {
  const signalBase = opts.signalBase ?? 'http://127.0.0.1:8787'
  const nodeId = getOrCreateNodeId()
  const name = opts.name ?? defaultName()

  let timer: ReturnType<typeof setInterval> | null = null

  async function register(): Promise<RegisterOutcome> {
    const res = await authFetch<{ ok?: boolean; error?: string }>(
      signalBase,
      '/auth/node/register',
      { nodeId, name }
    )
    if (res?.ok === true) return 'ok'
    return res?.error === 'quota-exceeded' ? 'quota-exceeded' : 'error'
  }

  async function heartbeat(): Promise<boolean> {
    const res = await authFetch<{ ok?: boolean }>(signalBase, '/auth/node/heartbeat', {
      nodeId,
    })
    return res?.ok === true
  }

  return {
    nodeId,
    start: async (): Promise<RegisterOutcome> => {
      const outcome = await register()
      if (outcome !== 'ok') return outcome
      await heartbeat()
      stop()
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
