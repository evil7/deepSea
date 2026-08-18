// ---------------------------------------------------------------------------
// useDiscussionsSync —— 登录后启动前端同步 worker（每 3 分钟刷新 discussions）
//   · user 非空 → startDiscussionsSync()；登出/未登录 → stopDiscussionsSync()
//   · 在 App 顶层调用一次，worker 生命周期全局唯一
// ---------------------------------------------------------------------------

import { useEffect } from "react"

import {
  startDiscussionsSync,
  stopDiscussionsSync,
} from "@/lib/github/discussions-sync"
import type { AuthUser } from "@/hooks/use-auth"

export function useDiscussionsSync(user: AuthUser | null): void {
  // 仅依赖 user 是否存在（login 变化视为同一次登录，避免反复重建 worker）
  const authed = Boolean(user)

  useEffect(() => {
    if (authed) {
      startDiscussionsSync()
      return stopDiscussionsSync
    }
    stopDiscussionsSync()
  }, [authed])
}
