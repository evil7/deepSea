/**
 * deepc-bridge 插件端配置同步 —— 账号级 key-value，D1 存储 + DO 推送通知。
 *
 * 已移回 D1（WS+DO 方案，见 docs/deepsea-deepc-bridge-config-gist.md 回退）：
 *   · 本地缓存一份「配置快照」{ key → { value, updatedAt } }（node 进程内存）
 *   · 登录后立即全量拉取（since=0）合并进本地
 *   · 收到 config-changed 通知（DO 推送，经 mailbox-host 的 WS）→ 拉增量
 *     （since=本地 maxUpdatedAt，since 下推 SQL 无变更读 0 行，零轮询）
 *   · 写：put(key, value) 直调 worker /auth/config/put（device_token 鉴权）
 *
 * 时效：LWW + worker 单调递增时间戳；本地合并 updatedAt 大者赢。
 */

import { DEFAULT_SIGNAL_BASE } from './device-auth'

export interface ConfigSnapshot {
  /** key → value。 */
  values: Record<string, string>
  /** key → updatedAt（worker 时间戳）。 */
  updated: Record<string, number>
  /** 本地最大 updatedAt（增量拉取 since）。 */
  maxUpdatedAt: number
}

/** 远端单条配置增量项。 */
interface RemoteConfigItem {
  key: string
  value: string
  updatedAt: number
}

/** node 端进程内缓存快照（node 无 localStorage，用内存变量）。 */
let snapshot: ConfigSnapshot = { values: {}, updated: {}, maxUpdatedAt: 0 }

/** 读本地缓存快照。 */
function readSnapshot(): ConfigSnapshot {
  return snapshot
}

/** 写本地缓存快照。 */
function writeSnapshot(snap: ConfigSnapshot): void {
  snapshot = snap
}

/** 合并远端增量到本地快照（updatedAt 大者赢），返回新增 key 数。 */
function applyRemote(items: RemoteConfigItem[]): number {
  const snap = readSnapshot()
  let count = 0
  for (const item of items) {
    if (item.updatedAt <= (snap.updated[item.key] ?? 0)) continue
    snap.values[item.key] = item.value
    snap.updated[item.key] = item.updatedAt
    if (item.updatedAt > snap.maxUpdatedAt) snap.maxUpdatedAt = item.updatedAt
    count++
  }
  writeSnapshot(snap)
  return count
}

/** 拉增量（since 下推），返回 items 或 null（未登录 / 失败）。 */
export async function listConfig(
  signalBase: string,
  since: number,
  token: string
): Promise<RemoteConfigItem[] | null> {
  if (!token) return null
  try {
    const res = await fetch(
      `${signalBase}/auth/config/list?since=${encodeURIComponent(String(since))}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) return null
    const data = (await res.json()) as { items?: RemoteConfigItem[] }
    return Array.isArray(data.items) ? data.items : null
  } catch {
    return null
  }
}

/** 写单条配置（device_token 鉴权），返回 worker 写入的 updatedAt 或 null。 */
export async function putConfig(
  signalBase: string,
  key: string,
  value: string,
  token: string
): Promise<number | null> {
  if (!token) return null
  try {
    const res = await fetch(`${signalBase}/auth/config/put`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ key, value }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { updatedAt?: number }
    return typeof data.updatedAt === 'number' ? data.updatedAt : null
  } catch {
    return null
  }
}

export interface ConfigSync {
  /** 拉增量合并（登录后首次 / config-changed 通知后调用，内部 debounce）。 */
  sync: () => void
  /** 写单条配置并立即回填本地快照。 */
  put: (key: string, value: string) => Promise<boolean>
  /** 停止（清理 debounce 定时器）。 */
  stop: () => void
}

/** 启动配置同步（登录后调用）：立即全量拉取 + 暴露 sync() 供 config-changed 通知触发。 */
export function startConfigSync(opts: { signalBase?: string; token: string }): ConfigSync {
  const signalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE

  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let pending = false
  let stopped = false

  async function doSync(): Promise<void> {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      const snap = readSnapshot()
      const items = await listConfig(signalBase, snap.maxUpdatedAt, opts.token)
      if (items && items.length > 0) applyRemote(items)
    } finally {
      running = false
      if (pending && !stopped) {
        pending = false
        void doSync()
      }
    }
  }

  function scheduleSync(): void {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void doSync()
    }, 300)
  }

  // 登录后立即全量拉取（since=本地 maxUpdatedAt，首次为 0）。
  scheduleSync()

  return {
    sync: scheduleSync,
    put: async (key, value) => {
      const updatedAt = await putConfig(signalBase, key, value, opts.token)
      if (updatedAt === null) return false
      // 回填本地快照（自己的写入立即生效，无需等通知回环）。
      const snap = readSnapshot()
      snap.values[key] = value
      snap.updated[key] = updatedAt
      if (updatedAt > snap.maxUpdatedAt) snap.maxUpdatedAt = updatedAt
      writeSnapshot(snap)
      return true
    },
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
