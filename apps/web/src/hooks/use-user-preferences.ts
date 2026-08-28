// ---------------------------------------------------------------------------
// useUserPreferences —— 用户偏好 hook（语言 / 主题 / 社区屏蔽）
//   · 初始：读 localStorage 缓存（含旧 key 迁移），零请求即时可用
//   · 登录后：后台 GET /auth/preferences 同步（TTL 60s 去重）→ D1 为准合并，
//     写本地缓存并应用 language / theme（登录态账号偏好优先于本地）
//   · 修改：写 localStorage 即时生效 + 防抖 PUT 到 D1（登录时）
//   · 未登录：仅本地（修改不推送）
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useAuth } from "@/hooks/use-auth"
import { useTheme } from "@/components/theme-provider"
import { BLOCKS_CHANGED_EVENT } from "@/lib/community-blocks"
import {
  fetchRemotePreferences,
  lastPreferencesFetchedAt,
  loadLocalPreferences,
  markPreferencesFetchedAt,
  normalizePreferences,
  PREFERENCES_STORAGE_KEY,
  pushRemotePreferences,
  writeLocalPreferences,
  type UserPreferences,
} from "@/lib/user-preferences"

/** 云端同步 TTL：距上次成功拉取 < 60s 不重复拉取（减少请求） */
const REMOTE_TTL_MS = 60_000

/** PUT 防抖：合并连续修改为一次推送 */
const PUSH_DEBOUNCE_MS = 600

/** 偏好语言 → 应用 i18n："system" = 切到浏览器语言后清 detector 缓存（刷新回退系统） */
async function applyLanguagePreference(
  lang: string,
  i18n: { changeLanguage: (l: string) => Promise<unknown> }
): Promise<void> {
  if (lang === "system") {
    const sys = navigator.language.startsWith("zh") ? "zh-CN" : "en-US"
    await i18n.changeLanguage(sys)
    try {
      localStorage.removeItem("deepsea.lang")
    } catch {
      /* ignore */
    }
  } else {
    await i18n.changeLanguage(lang)
  }
}

export function useUserPreferences() {
  const { user } = useAuth()
  const { i18n } = useTranslation()
  const { setTheme } = useTheme()

  const [prefs, setPrefs] = useState<UserPreferences>(loadLocalPreferences)
  // 最新偏好引用（供 save 在任意时机读取，避免渲染期 updater 内副作用）
  const prefsRef = useRef(prefs)
  // 拉取锁（并发去重）
  const fetchingRef = useRef(false)
  // 最近一次成功拉取时间（本地缓存 fetchedAt 兜底）
  const fetchedAtRef = useRef(lastPreferencesFetchedAt())
  // 防抖计时器
  const pushTimerRef = useRef<number | null>(null)
  // 避免 setState 在 effect 同步路径（React Compiler lint）——同步逻辑放宏任务
  const syncedRef = useRef(false)

  // 登录态变化 → 同步云端偏好（登录后首次 / 登出后重置为本地）
  useEffect(() => {
    if (!user) {
      syncedRef.current = false
      const local = loadLocalPreferences()
      prefsRef.current = local
      setPrefs(local)
      return
    }
    const id = window.setTimeout(async () => {
      if (fetchingRef.current) return
      fetchingRef.current = true
      try {
        // TTL 去重：60s 内已成功拉取则不重复请求（页面刷新/切页时直接吃缓存）
        if (Date.now() - fetchedAtRef.current < REMOTE_TTL_MS) {
          syncedRef.current = true
          return
        }
        const remote = await fetchRemotePreferences()
        if (!remote) return
        fetchedAtRef.current = Date.now()
        syncedRef.current = true
        // D1 有记录的字段以云端为准；本地独有的值保留（云端未记录）
        const merged = normalizePreferences({
          ...loadLocalPreferences(),
          ...remote,
        })
        writeLocalPreferences(merged)
        prefsRef.current = merged
        setPrefs(merged)
        // 应用语言 / 主题（账号级偏好覆盖本地；本地手动修改会在后续 save 回写）
        if (merged.language) {
          void applyLanguagePreference(merged.language, i18n)
        }
        if (merged.theme) {
          setTheme(merged.theme)
        }
        markPreferencesFetchedAt(fetchedAtRef.current)
      } finally {
        fetchingRef.current = false
      }
    }, 0)
    return () => window.clearTimeout(id)
    // user 引用变化触发；i18n/setTheme 稳定引用不参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  /** 合并修改：写本地 + 广播 + （登录时）防抖推送云端 */
  // 注意：dispatchEvent 必须在 setState 之外调用——updater 在渲染调度期间执行，
  // 其中同步派发事件会触发监听器 setState，导致
  // “Cannot update a component while rendering a different component”。
  const save = useCallback(
    (patch: Partial<UserPreferences>) => {
      const next = normalizePreferences({ ...prefsRef.current, ...patch })
      prefsRef.current = next
      setPrefs(next)
      writeLocalPreferences(next)
      // 广播：同页多个 useUserPreferences / useCommunityBlocks 实例同步
      window.dispatchEvent(new CustomEvent(BLOCKS_CHANGED_EVENT))
      // 推送云端（仅登录态；防抖合并连续修改）
      if (user) {
        if (pushTimerRef.current !== null) {
          window.clearTimeout(pushTimerRef.current)
        }
        pushTimerRef.current = window.setTimeout(() => {
          void pushRemotePreferences(next)
        }, PUSH_DEBOUNCE_MS)
      }
    },
    [user]
  )

  // 同页广播 / 跨标签页 storage 同步（多实例一致）
  useEffect(() => {
    const sync = () => {
      const next = loadLocalPreferences()
      prefsRef.current = next
      setPrefs(next)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFERENCES_STORAGE_KEY) sync()
    }
    window.addEventListener(BLOCKS_CHANGED_EVENT, sync)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener(BLOCKS_CHANGED_EVENT, sync)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  // 卸载清理防抖计时器
  useEffect(() => {
    return () => {
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current)
      }
    }
  }, [])

  return { prefs, save }
}

export type { UserPreferences }
