// ---------------------------------------------------------------------------
// user-preferences —— 用户偏好（语言 / 主题 / 社区屏蔽）
//   · 云端：D1 user_preferences（登录后跟随账号，跨设备同步）
//   · 本地：localStorage 缓存（`deepsea.preferences`），登录后同步减少请求
//   · 未登录：仅本地（旧 `deepsea.community-blocks` key 自动迁移）
// ---------------------------------------------------------------------------

import type { CommunityBlocks } from "@/lib/community-blocks"

/** 用户偏好 = 社区屏蔽设置 + 语言 + 主题 */
export interface UserPreferences extends CommunityBlocks {
  /** 界面语言（"" = 未设置，跟随本地/检测） */
  language: string
  /** 明暗主题（"" = 未设置，跟随本地/系统） */
  theme: string
}

export const PREFERENCES_STORAGE_KEY = "deepsea.preferences"
/** 旧版社区屏蔽 key（v1 迁移源） */
export const LEGACY_BLOCKS_STORAGE_KEY = "deepsea.community-blocks"

export const DEFAULT_PREFERENCES: UserPreferences = {
  language: "",
  theme: "",
  blockedUsers: [],
  thumbsDownThreshold: 3,
  mode: "collapse",
}

/** localStorage 缓存结构（含版本与拉取时间戳，供 TTL 去重） */
interface CachedPreferences {
  v: 1
  prefs: UserPreferences
  fetchedAt: number
}

/** 从 localStorage 读取偏好（含旧 key 迁移；损坏回退默认） */
export function loadLocalPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY)
    if (raw) {
      const cached = JSON.parse(raw) as CachedPreferences
      if (cached?.prefs && typeof cached.prefs === "object") {
        return normalizePreferences(cached.prefs)
      }
    }
    // 旧 key 迁移（deepsea.community-blocks → deepsea.preferences）
    const legacy = localStorage.getItem(LEGACY_BLOCKS_STORAGE_KEY)
    if (legacy) {
      try {
        const old = JSON.parse(legacy) as Partial<CommunityBlocks>
        const merged: UserPreferences = {
          ...DEFAULT_PREFERENCES,
          blockedUsers: Array.isArray(old.blockedUsers) ? old.blockedUsers : [],
          thumbsDownThreshold:
            typeof old.thumbsDownThreshold === "number" ? old.thumbsDownThreshold : 3,
          mode: old.mode === "hide" || old.mode === "off" ? old.mode : "collapse",
        }
        writeLocalPreferences(merged)
        localStorage.removeItem(LEGACY_BLOCKS_STORAGE_KEY)
        return merged
      } catch {
        // 旧数据损坏则忽略
      }
    }
    return DEFAULT_PREFERENCES
  } catch {
    return DEFAULT_PREFERENCES
  }
}

/** 归一化（字段类型 / 非法值兜底） */
export function normalizePreferences(p: Partial<UserPreferences>): UserPreferences {
  return {
    language:
      p.language === "zh-CN" || p.language === "en-US" || p.language === "system"
        ? p.language
        : "",
    theme:
      p.theme === "light" || p.theme === "dark" || p.theme === "system"
        ? p.theme
        : "",
    blockedUsers: Array.isArray(p.blockedUsers)
      ? p.blockedUsers.filter((u): u is string => typeof u === "string")
      : [],
    thumbsDownThreshold:
      typeof p.thumbsDownThreshold === "number" &&
      Number.isFinite(p.thumbsDownThreshold) &&
      p.thumbsDownThreshold >= 0
        ? Math.floor(p.thumbsDownThreshold)
        : 3,
    mode: p.mode === "hide" || p.mode === "off" ? p.mode : "collapse",
  }
}

/** 写 localStorage（保持 fetchedAt） */
export function writeLocalPreferences(prefs: UserPreferences): void {
  try {
    const cached = readCachedRaw()
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        prefs,
        fetchedAt: cached?.fetchedAt ?? 0,
      } satisfies CachedPreferences)
    )
  } catch {
    // 隐私模式等极端情况静默忽略
  }
}

/** 读取缓存原文（无则 null） */
function readCachedRaw(): CachedPreferences | null {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CachedPreferences
  } catch {
    return null
  }
}

/** 最近一次云端拉取时间（未拉取返回 0） */
export function lastPreferencesFetchedAt(): number {
  return readCachedRaw()?.fetchedAt ?? 0
}

/** 记录云端拉取时间戳（防抖：60s 内不重复拉取） */
export function markPreferencesFetchedAt(ts = Date.now()): void {
  const cached = readCachedRaw()
  if (!cached) return
  try {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...cached, fetchedAt: ts })
    )
  } catch {
    // ignore
  }
}

/** 云端偏好响应结构 */
export interface RemotePreferencesResponse {
  authed: boolean
  preferences?: UserPreferences
  ok?: boolean
}

/** GET /auth/preferences —— 拉取云端偏好（未登录/失败返回 null） */
export async function fetchRemotePreferences(): Promise<UserPreferences | null> {
  try {
    const res = await fetch("/auth/preferences", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return null
    const data = (await res.json()) as RemotePreferencesResponse
    if (!data.authed || !data.preferences) return null
    return normalizePreferences(data.preferences)
  } catch {
    return null
  }
}

/** PUT /auth/preferences —— 推送偏好到云端（未登录/失败静默忽略） */
export async function pushRemotePreferences(
  prefs: UserPreferences
): Promise<boolean> {
  try {
    const res = await fetch("/auth/preferences", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    })
    return res.ok
  } catch {
    return false
  }
}
