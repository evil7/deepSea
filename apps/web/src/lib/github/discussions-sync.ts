// ---------------------------------------------------------------------------
// discussions-sync —— 登录用户的前端定时同步（主线程 setInterval + octokit 直调）
//   · 登录后启动：每 3 分钟用前端 octokit（loadDiscussionsLive）直调 GitHub
//     GraphQL 拉最新讨论列表（不经过 Worker 代理）
//   · 拿到最新列表 → setDiscussionsCache 替换缓存 + 通知订阅者（首页酒馆屏 /
//     社区面板自动刷新）
//   · 未登录 / 登出 → 停止定时器
//   · octokit 的 GraphQL 请求是异步 fetch，不阻塞主线程，无需 Web Worker
// ---------------------------------------------------------------------------

import {
  loadDiscussionsLive,
  setDiscussionsCache,
} from "@/lib/github/discussions"

/** 同步间隔：3 分钟（分钟级新鲜度） */
export const DISCUSSIONS_SYNC_INTERVAL = 3 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let running = false

/** 拉一次最新列表并更新缓存（幂等，失败静默） */
async function tick() {
  if (running) return
  running = true
  try {
    const list = await loadDiscussionsLive()
    if (list) {
      setDiscussionsCache(list)
    }
  } catch {
    // 网络/限流抖动：静默跳过本轮
  } finally {
    running = false
  }
}

/** 启动定时同步（已启动则复用） */
export function startDiscussionsSync(): void {
  if (timer) return
  tick()
  timer = setInterval(tick, DISCUSSIONS_SYNC_INTERVAL)
}

/** 停止定时同步（登出 / 未登录时调用） */
export function stopDiscussionsSync(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 当前是否在同步中 */
export function isDiscussionsSyncing(): boolean {
  return timer !== null
}
