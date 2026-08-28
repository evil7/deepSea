// ---------------------------------------------------------------------------
// useCommunityBlocks —— 社区软屏蔽偏好 hook（数据源：useUserPreferences）
//   · blockedUsers / thumbsDownThreshold / mode 存储于偏好（localStorage + D1）
//   · 暴露「低质屏蔽」临时开关（会话级，不持久化；null = 跟随个人设置）
//   · 同页广播事件同步（临时开关变化 / 偏好变化）
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react"

import {
  addBlockedUser,
  BLOCKS_CHANGED_EVENT,
  isLowQualityEnabled,
  removeBlockedUser,
  setLowQualityOverride,
  type BlockMode,
  type CommunityBlocks,
} from "@/lib/community-blocks"
import { useUserPreferences } from "@/hooks/use-user-preferences"

export function useCommunityBlocks() {
  const { prefs, save } = useUserPreferences()

  // 偏好子集（community 屏蔽字段）
  const blocks: CommunityBlocks = {
    blockedUsers: prefs.blockedUsers,
    thumbsDownThreshold: prefs.thumbsDownThreshold,
    mode: prefs.mode,
  }

  // 临时开关变化（BLOCKS_CHANGED_EVENT）→ 强制重渲染刷新 isLowQualityEnabled
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((v) => v + 1)
    window.addEventListener(BLOCKS_CHANGED_EVENT, bump)
    return () => window.removeEventListener(BLOCKS_CHANGED_EVENT, bump)
  }, [])

  /** 低质屏蔽是否生效（临时开关优先；默认跟随个人设置） */
  const lowQualityEnabled = isLowQualityEnabled(blocks)

  /** 设置低质屏蔽临时开关（null = 复位跟随个人设置；不持久化） */
  const setLowQualityEnabled = useCallback((value: boolean | null) => {
    setLowQualityOverride(value)
  }, [])

  /** 屏蔽一个用户（若已屏蔽则无变化） */
  const blockUser = useCallback(
    (login: string) => {
      save({ blockedUsers: addBlockedUser(prefs, login).blockedUsers })
    },
    [prefs, save]
  )

  /** 解除屏蔽一个用户 */
  const unblockUser = useCallback(
    (login: string) => {
      save({ blockedUsers: removeBlockedUser(prefs, login).blockedUsers })
    },
    [prefs, save]
  )

  /** 设置低质阈值（0 = 关闭） */
  const setThumbsDownThreshold = useCallback(
    (threshold: number) => {
      save({ thumbsDownThreshold: Math.max(0, Math.floor(threshold)) })
    },
    [save]
  )

  /** 设置处理模式（collapse / hide / off） */
  const setMode = useCallback(
    (mode: BlockMode) => {
      save({ mode })
    },
    [save]
  )

  /** 整体更新（供设置页批量写入） */
  const update = useCallback(
    (next: CommunityBlocks) => {
      save({
        blockedUsers: next.blockedUsers,
        thumbsDownThreshold: next.thumbsDownThreshold,
        mode: next.mode,
      })
    },
    [save]
  )

  return {
    blocks,
    lowQualityEnabled,
    setLowQualityEnabled,
    update,
    blockUser,
    unblockUser,
    setThumbsDownThreshold,
    setMode,
  }
}
