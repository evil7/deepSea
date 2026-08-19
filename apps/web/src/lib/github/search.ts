import { octokit } from "@/lib/github/client"
import { CACHE_FILES, loadCacheFile } from "@/lib/github/cache"
import { PLUGIN_TOPICS } from "@/lib/github/topics"
import type { PluginRepo } from "@/lib/github/types"

// ---------------------------------------------------------------------------
// 插件仓库搜索
//   · 前端主路径：加载缓存数据（cache 分支 → 仓库 seed 兜底）→ 内存过滤/排序/分页，
//     不消耗 API 配额
//   · 实时刷新：手动触发 octokit 搜索（限流敏感，需要 token），结果归一化
// ---------------------------------------------------------------------------

// —— 缓存数据加载 ——

let seedCache: PluginRepo[] | null = null
let seedLoading: Promise<PluginRepo[]> | null = null

/**
 * 加载插件缓存数据（内存缓存；cache 分支优先，仓库 seed 兜底，失败返回空数组）。
 * @param url 仓库兜底 seed 地址（cache 分支不可用时回退到它）
 */
export function loadPluginSeed(url: string): Promise<PluginRepo[]> {
  if (seedCache) {
    return Promise.resolve(seedCache)
  }
  if (!seedLoading) {
    seedLoading = loadCacheFile<PluginRepo[]>(CACHE_FILES.repos)
      .catch(() =>
        fetch(url).then((res) => {
          if (!res.ok) {
            throw new Error(`seed ${res.status}`)
          }
          return res.json()
        })
      )
      .then((data: PluginRepo[]) => {
        seedCache = Array.isArray(data) ? data : []
        return seedCache
      })
      .catch(() => {
        seedCache = []
        return []
      })
  }
  return seedLoading
}

// —— 实时搜索（octokit，手动触发） ——

/** 将 octokit repo 对象归一化为 PluginRepo */
function normalizeRepo(it: Record<string, unknown>): PluginRepo {
  return {
    full_name: String(it.full_name ?? ""),
    html_url: String(it.html_url ?? ""),
    description: String(it.description ?? ""),
    language: (it.language as string | null) ?? null,
    stargazers_count: Number(it.stargazers_count ?? 0),
    forks_count: Number(it.forks_count ?? 0),
    open_issues_count: Number(it.open_issues_count ?? 0),
    created_at: (it.created_at as string | null) ?? null,
    pushed_at: (it.pushed_at as string | null) ?? null,
    updated_at: (it.updated_at as string | null) ?? null,
    topics: Array.isArray(it.topics) ? (it.topics as string[]) : [],
    license:
      it.license && typeof it.license === "object"
        ? ((it.license as { spdx_id?: string | null }).spdx_id ?? null)
        : null,
    archived: Boolean(it.archived),
    is_official: it.full_name === "deepseek-ai/deepseek-harness",
    sources: ["live"],
  }
}

/**
 * 实时搜索（GitHub Search API）
 * 注意：GitHub 不支持 topic:a OR topic:b 合并查询（返回空），逐 topic 查询。
 * 限流敏感：匿名 10 req/min，token 30 req/min；建议带 token 使用。
 */
export async function liveSearchRepos(): Promise<PluginRepo[]> {
  const merged = new Map<string, PluginRepo>()
  // 顺序执行（GitHub 不支持 topic OR 合并，且逐 topic 请求须避免并发触发限流）
  /* eslint-disable no-await-in-loop */
  for (const topic of PLUGIN_TOPICS) {
    try {
      const res = await octokit.search.repos({
        q: `topic:${topic}`,
        sort: "stars",
        order: "desc",
        per_page: 100,
      })
      for (const item of res.data.items) {
        const repo = normalizeRepo(item as unknown as Record<string, unknown>)
        const prev = merged.get(repo.full_name)
        if (prev) {
          prev.topics = [...new Set([...prev.topics, ...repo.topics])]
        } else {
          merged.set(repo.full_name, repo)
        }
      }
    } catch {
      // 单 topic 失败（限流等）跳过，保留已有结果
      continue
    }
  }
  /* eslint-enable no-await-in-loop */
  return [...merged.values()]
}

/**
 * 按搜索条件实时查询（自行捕捞模式）
 * 把 UI 过滤条件映射为 GitHub Search qualifier：
 *   · keyword        → 文本（多词自动加引号，避免 OR 拆词） + in:name,description
 *   · language       → language:xxx
 *   · minStars       → stars:>=n
 *   · createdWithinDays → created:<YYYY-MM-DD（创建距今 ≥ N 天；0 = 不限）
 * 无关键词时用核心 dsh 关键词 OR 兜底（避免空查询 422）。
 * 限流敏感：需登录 token（30 req/min），匿名 10 req/min；异常向上抛出。
 */
export async function liveSearchReposByFilter(filter: {
  keyword?: string
  language?: string | null
  minStars?: number
  createdWithinDays?: number
}): Promise<PluginRepo[]> {
  const textParts: string[] = []
  const kw = filter.keyword?.trim()
  if (kw) {
    textParts.push(/\s/.test(kw) ? `"${kw}"` : kw)
  } else {
    // 兜底：核心 dsh 专属长关键词（3 个 term = 2 个 OR，未超 5 上限）
    // ⚠️ 不含裸 "dsh"（子串匹配撞 Box2DSharp/DShot/DShield 等无关项目）
    textParts.push(
      '"deepseek-harness"',
      '"deepseek harness"',
      '"dsh-plugin"'
    )
  }
  const qualifiers: string[] = []
  if (filter.language) {
    qualifiers.push(`language:${filter.language}`)
  }
  if (filter.minStars && filter.minStars > 0) {
    qualifiers.push(`stars:>=${filter.minStars}`)
  }
  if (filter.createdWithinDays && filter.createdWithinDays > 0) {
    const d = new Date(Date.now() - filter.createdWithinDays * 86400000)
    qualifiers.push(`created:<${d.toISOString().slice(0, 10)}`)
  }
  const q =
    `${textParts.join(" OR ")} in:name,description ${qualifiers.join(" ")}`.trim()
  const res = await octokit.search.repos({
    q,
    sort: "stars",
    order: "desc",
    per_page: 100,
  })
  return res.data.items.map((it) =>
    normalizeRepo(it as unknown as Record<string, unknown>)
  )
}

// —— 内存过滤 / 排序 / 分页（纯函数，供 UI 调用） ——

export type PluginSortKey = "stars" | "updated" | "created"
export type PluginViewMode = "hot" | "latest"

/** 按视图模式排序（热门=star，最新=pushed_at） */
export function sortPlugins(
  list: PluginRepo[],
  mode: PluginViewMode
): PluginRepo[] {
  const sorted = [...list].toSorted((a, b) =>
    mode === "hot"
      ? b.stargazers_count - a.stargazers_count
      : (b.pushed_at ?? "").localeCompare(a.pushed_at ?? "")
  )
  // 官方库置顶
  return sorted.toSorted(
    (a, b) => Number(b.is_official) - Number(a.is_official)
  )
}

export interface PluginFilter {
  /** 关键词（匹配 name/description/topics） */
  keyword: string
  /** 语言（null = 全部） */
  language: string | null
  /** star 下限 */
  minStars: number
  /** 创建时间限制：仅收录 created_at 距今 ≥ 该天数的仓库（与缓存脚本 minAgeDays
   *  门槛一致；0 = 不限） */
  createdWithinDays: number
}

/** 二次过滤（搜索框 + 语言 + star + 创建时间） */
export function filterPlugins(
  list: PluginRepo[],
  filter: PluginFilter
): PluginRepo[] {
  const kw = filter.keyword.trim().toLowerCase()
  // 创建时间阈值（createdWithinDays > 0 时生效）
  const cutoff =
    filter.createdWithinDays > 0
      ? Date.now() - filter.createdWithinDays * 24 * 60 * 60 * 1000
      : 0
  return list.filter((r) => {
    if (kw) {
      const hay =
        `${r.full_name} ${r.description} ${r.topics.join(" ")}`.toLowerCase()
      if (!hay.includes(kw)) {
        return false
      }
    }
    if (filter.language && (r.language ?? "") !== filter.language) {
      return false
    }
    if (r.stargazers_count < filter.minStars) {
      return false
    }
    if (cutoff > 0) {
      const created = r.created_at ? Date.parse(r.created_at) : NaN
      // 仅收录创建距今 ≥ N 天（用户主动筛选；缺失创建时间无法判断 → 剔除）
      if (Number.isNaN(created) || created > cutoff) {
        return false
      }
    }
    return true
  })
}

/** 统计语言分布（用于语言 badge 列表） */
export function collectLanguages(list: PluginRepo[]): string[] {
  const set = new Set<string>()
  for (const r of list) {
    if (r.language) {
      set.add(r.language)
    }
  }
  return [...set].toSorted()
}
