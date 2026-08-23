/**
 * deepc-link 插件端配置同步 —— 账号级 key-value，D1 存储 + DO 推送通知。
 *
 * 已移回 D1（WS+DO 方案，见 docs/deepsea-deepc-bridge-config-gist.md 回退）：
 *   · 本地缓存一份「配置快照」{ key → { value, updatedAt } }（node 进程内存）
 *   · 登录后立即全量拉取（since=0）合并进本地
 *   · 收到 config-changed 通知（DO 推送，经 mailbox-host 的 WS）→ 拉增量
 *     （since=本地 maxUpdatedAt，since 下推 SQL 无变更读 0 行，零轮询）
 *   · 写：put(key, value) 直调 worker /auth/config/put（device_token 鉴权）
 *
 * 时效：LWW + worker 单调递增时间戳；本地合并 updatedAt 大者赢。
 *
 * 【自动同步 + 版本冲突（需求 2）】：
 *   不再需要用户手动点「同步」——登录后 + config-changed 通知时自动 sync。
 *   引入「基线版本 baseVersion」做冲突检测：
 *     · 本地 put 时记录 baseVersion = 当前远端 updatedAt（改前的远端版本）。
 *     · sync 拉远端起，若某 key 本地「脏」（改过未合并）且远端 updatedAt > baseVersion
 *       （远端在我改之后又被别的设备改了）→ 判定为「完全冲突」。
 *       不自动应用远端（避免覆盖我本地未同步的修改），而是通过 onConflict 回调提醒，
 *       由用户在 UI 上选择「拉取远端 / 强制上传」。
 *     · 无冲突时 LWW：远端 updatedAt 大者赢，正常合并。
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

/** 本地上次修改各 key 所基于的远端 updatedAt（改前基线）。 */
const baseVersion: Record<string, number> = {}
/** 本地「脏」key 集合（改过但尚未无冲突合并到远端）。 */
const dirtyKeys = new Set<string>()
/** 待决冲突 key 集合（远端在我改后又被改，等待用户处置）。 */
const conflictKeys = new Set<string>()
/** 冲突回调（host-ui 监听，用 toast 提示用户选择）。 */
const conflictHandlers = new Set<(keys: string[]) => void>()

/** 读本地缓存快照。 */
function readSnapshot(): ConfigSnapshot {
  return snapshot
}

/** 写本地缓存快照。 */
function writeSnapshot(snap: ConfigSnapshot): void {
  snapshot = snap
}

/** 合并远端增量到本地快照（updatedAt 大者赢；冲突 key 不自动应用）。 */
function applyRemote(items: RemoteConfigItem[]): number {
  const snap = readSnapshot()
  let count = 0
  for (const item of items) {
    // 冲突判定：本地脏（改过未合并）且远端在我改后又变 → 不自动应用，标记冲突。
    if (dirtyKeys.has(item.key)) {
      const localBase = baseVersion[item.key] ?? 0
      if (item.updatedAt > localBase) {
        conflictKeys.add(item.key)
        continue
      }
    }
    if (item.updatedAt <= (snap.updated[item.key] ?? 0)) continue
    snap.values[item.key] = item.value
    snap.updated[item.key] = item.updatedAt
    if (item.updatedAt > snap.maxUpdatedAt) snap.maxUpdatedAt = item.updatedAt
    count++
  }
  writeSnapshot(snap)
  if (conflictKeys.size > 0) notifyConflict()
  return count
}

/** 手动写入某 key 后回填本地（自己写入立即生效，无需等通知回环）。 */
function applyOwnPut(key: string, value: string, updatedAt: number): void {
  const snap = readSnapshot()
  snap.values[key] = value
  snap.updated[key] = updatedAt
  if (updatedAt > snap.maxUpdatedAt) snap.maxUpdatedAt = updatedAt
  writeSnapshot(snap)
  // 本地已是最新，视为已合并，清除冲突/脏标记并刷新基线。
  baseVersion[key] = updatedAt
  dirtyKeys.delete(key)
  conflictKeys.delete(key)
}

/** 触发冲突回调（供 host-ui toast 提示）。 */
function notifyConflict(): void {
  const keys = [...conflictKeys]
  for (const h of conflictHandlers) h(keys)
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
  /** 拉增量合并（登录后首次 / config-changed 通知后调用，内部 debounce；自动）。 */
  sync: () => void
  /** 写单条配置并立即回填本地快照（user 主动改配置）。 */
  put: (key: string, value: string) => Promise<boolean>
  /** 当前待决冲突 key 集合。 */
  conflicts: () => string[]
  /** 是否仍有待决冲突。 */
  hasConflicts: () => boolean
  /** 处置冲突：pull=拉取远端（应用远端值，丢弃本地脏）；upload=强制上传本地值。 */
  resolveConflict: (key: string, choice: 'pull' | 'upload') => Promise<void>
  /** 订阅「出现冲突」回调（host-ui toast 用），返回取消函数。 */
  onConflict: (handler: (keys: string[]) => void) => () => void
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
      const snap = readSnapshot()
      // 记录改前基线（当前远端版本），并标记本地脏。
      baseVersion[key] = snap.updated[key] ?? 0
      dirtyKeys.add(key)
      const updatedAt = await putConfig(signalBase, key, value, opts.token)
      if (updatedAt === null) {
        // 写失败：保留脏标记（下次 sync 可能冲突判定），返回失败。
        return false
      }
      // 写入成功：回填本地 + 刷新基线 + 清除脏/冲突。
      applyOwnPut(key, value, updatedAt)
      return true
    },
    conflicts: () => [...conflictKeys],
    hasConflicts: () => conflictKeys.size > 0,
    resolveConflict: async (key, choice) => {
      conflictKeys.delete(key)
      const snap = readSnapshot()
      if (choice === 'upload') {
        // 强制上传本地值：以当前本地值重写远端。
        const localValue = snap.values[key]
        if (localValue === undefined) return
        const updatedAt = await putConfig(signalBase, key, localValue, opts.token)
        if (updatedAt !== null) applyOwnPut(key, localValue, updatedAt)
        return
      }
      // 拉取远端：清除脏标记并回填基线，下一次 sync 会以远端为准应用。
      baseVersion[key] = snap.updated[key] ?? 0
      dirtyKeys.delete(key)
      // 主动拉一次增量，让远端值落地。
      scheduleSync()
    },
    onConflict: (handler) => {
      conflictHandlers.add(handler)
      return () => {
        conflictHandlers.delete(handler)
      }
    },
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
