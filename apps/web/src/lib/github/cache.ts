// ---------------------------------------------------------------------------
// cache 分支缓存读取（前端）
//   缓存数据发布在 git 的 `cache` 孤儿分支（见 scripts/publish-cache.mjs），
//   前端通过 raw.githubusercontent.com 匿名读取（零 API 配额 + CORS 允许）。
//   失败回退到仓库内的 /data/*.json（冷启动兜底）。
// ---------------------------------------------------------------------------

const CACHE_OWNER = "evil7"
const CACHE_REPO = "deepSea"
const CACHE_BRANCH = "cache"

/** cache 分支上的文件名（与 scripts/publish-cache.mjs 的 FILES 一致） */
export const CACHE_FILES = {
  repos: "deepseek-harness-repos.json",
  discussions: "discussions.json",
  officialDiscussions: "discussions-official.json",
} as const

/** cache 分支文件的 raw 地址（零 API 配额 + CORS 允许） */
export function cacheRawUrl(file: string): string {
  return `https://raw.githubusercontent.com/${CACHE_OWNER}/${CACHE_REPO}/${CACHE_BRANCH}/${file}`
}

/** 读 cache 分支缓存（失败抛错，由调用方降级） */
export async function loadCacheFile<T>(file: string): Promise<T> {
  const res = await fetch(cacheRawUrl(file), { cache: "no-store" })
  if (!res.ok) {
    throw new Error(`cache ${res.status}`)
  }
  return (await res.json()) as T
}

/**
 * cache 优先 + 仓库 seed 兜底加载。
 *   ① 先读 cache 分支（最新）；失败则 ② 读仓库 /data 静态 seed；再失败返回空数组。
 */
export async function loadWithCacheFallback<T>(
  file: string,
  fallbackUrl: string
): Promise<T[]> {
  try {
    return await loadCacheFile<T[]>(file)
  } catch {
    try {
      const res = await fetch(fallbackUrl)
      if (!res.ok) {
        return []
      }
      return (await res.json()) as T[]
    } catch {
      return []
    }
  }
}
