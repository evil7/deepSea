import { octokit } from "@/lib/github/client"
import type { RepoInfo, RepoReadme, RepoRelease } from "@/lib/github/types"

// ---------------------------------------------------------------------------
// 单个仓库详情（octokit repos.get / repos.getReadme + raw README 下载）
// 详情页按需调用，每次 1~2 个 API 请求，限流可接受。
// ---------------------------------------------------------------------------

/** 查询仓库基础信息（404 抛出错误） */
export async function fetchRepoInfo(
  owner: string,
  repo: string
): Promise<RepoInfo> {
  const res = await octokit.repos.get({ owner, repo })
  const d = res.data
  return {
    full_name: d.full_name,
    html_url: d.html_url,
    description: d.description ?? "",
    language: d.language,
    stargazers_count: d.stargazers_count,
    forks_count: d.forks_count,
    open_issues_count: d.open_issues_count,
    subscribers_count: d.subscribers_count ?? 0,
    created_at: d.created_at,
    pushed_at: d.pushed_at,
    updated_at: d.updated_at,
    topics: d.topics ?? [],
    license: d.license?.spdx_id ?? null,
    homepage: d.homepage,
    archived: d.archived,
    default_branch: d.default_branch,
    size: d.size,
    owner: { login: d.owner.login, avatar_url: d.owner.avatar_url },
  }
}

/**
 * 获取 README
 * 策略：octokit repos.getReadme 拿元数据（download_url），
 *       再 fetch raw 文本（raw.githubusercontent.com，不占 API 配额，支持 CORS）。
 * 无 README 时返回 null。
 */
export async function fetchRepoReadme(
  owner: string,
  repo: string
): Promise<RepoReadme | null> {
  try {
    const res = await octokit.repos.getReadme({ owner, repo })
    const downloadUrl = res.data.download_url
    if (!downloadUrl) {
      // 无 download_url 时用 API content 解码
      const content = res.data.content
      if (content) {
        const text = atob(content.replace(/\s/g, ""))
        return {
          html_url: res.data.html_url ?? "",
          markdown: text,
        }
      }
      return null
    }
    const raw = await fetch(downloadUrl)
    if (!raw.ok) {
      return null
    }
    return {
      html_url: res.data.html_url ?? "",
      markdown: await raw.text(),
    }
  } catch {
    return null
  }
}

/** README 中相对资源路径 → raw.githubusercontent 绝对路径（图片等可显示） */
export function resolveReadmeAssetUrl(
  owner: string,
  repo: string,
  branch: string,
  src: string
): string {
  if (/^(https?:)?\/\//.test(src)) {
    return src
  }
  if (src.startsWith("data:")) {
    return src
  }
  const clean = src.replace(/^\.\//, "").replace(/^\/+/, "")
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${clean}`
}

/** 查询最新 release（失败返回 null，不抛错） */
export async function fetchRepoRelease(
  owner: string,
  repo: string
): Promise<RepoRelease | null> {
  try {
    const res = await octokit.repos.getLatestRelease({ owner, repo })
    const d = res.data
    return {
      tag_name: d.tag_name,
      name: d.name,
      html_url: d.html_url,
      published_at: d.published_at,
      assets: (d.assets ?? [])
        .filter((a) => a.browser_download_url)
        .map((a) => ({
          name: a.name,
          download_url: a.browser_download_url,
          size: a.size,
        })),
      draft: d.draft ?? false,
      prerelease: d.prerelease ?? false,
    }
  } catch {
    // 无 release / 限流等 → 不展示区块
    return null
  }
}
