// ---------------------------------------------------------------------------
// cache 分支缓存读取（前端）
//   缓存数据发布在 git 的 `cache` 孤儿分支（见 scripts/publish-cache.mjs），
//   前端按「raw 直读 → REST API 兜底 → 仓库 /data 冷启动兜底」三级容错读取：
//     · raw.githubusercontent.com/{owner}/{repo}/refs/heads/{branch}/{file}
//       （零 API 配额 + CORS 允许，主路径）
//     · api.github.com/repos/{owner}/{repo}/contents/{file}?ref={branch}
//       带 Accept: application/vnd.github.raw（匿名 60 req/hr，兜底）
//     · 仓库 /data/*.json（冷启动，见 loadWithCacheFallback）
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

/** cache 分支文件的 raw 地址（refs/heads 格式，零 API 配额 + CORS 允许） */
export function cacheRawUrl(file: string): string {
  return `https://raw.githubusercontent.com/${CACHE_OWNER}/${CACHE_REPO}/refs/heads/${CACHE_BRANCH}/${file}`
}

/** cache 分支文件的 REST API raw 地址（匿名兜底，60 req/hr 限流） */
export function cacheApiUrl(file: string): string {
  return `https://api.github.com/repos/${CACHE_OWNER}/${CACHE_REPO}/contents/${file}?ref=${CACHE_BRANCH}`
}

/** 读 cache 分支缓存（raw 直读失败后走 REST API 兜底；均失败抛错由调用方降级） */
export async function loadCacheFile<T>(file: string): Promise<T> {
  // ① 主路径：raw.githubusercontent.com（零配额）
  try {
    const res = await fetch(cacheRawUrl(file), { cache: "no-store" })
    if (res.ok) {
      return (await res.json()) as T
    }
  } catch {
    // raw 网络异常 → 继续 REST API 兜底
  }

  // ② 兜底：REST API contents（Accept: application/vnd.github.raw 直接返回原始内容）
  const apiRes = await fetch(cacheApiUrl(file), {
    cache: "no-store",
    headers: { Accept: "application/vnd.github.raw" },
  })
  if (!apiRes.ok) {
    throw new Error(`cache api ${apiRes.status}`)
  }
  return (await apiRes.json()) as T
}

/**
 * cache 优先 + 仓库 seed 兜底加载。
 *   ① 先读 cache 分支（raw → REST API 两级）；失败则 ② 读仓库 /data 静态 seed；
 *   再失败返回空数组。
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
