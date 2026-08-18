// ---------------------------------------------------------------------------
// 插件仓库类型定义（前端统一使用）
// 种子数据字段与 scripts/search-deepseek-repos.mjs 输出一致；
// 实时搜索（octokit）结果会归一化到同一结构。
// ---------------------------------------------------------------------------

export interface PluginRepo {
  full_name: string
  html_url: string
  description: string
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  created_at: string | null
  pushed_at: string | null
  updated_at: string | null
  topics: string[]
  license: string | null
  archived: boolean
  is_official: boolean
  sources: string[]
}

/** 仓库基础信息（详情页，octokit repos.get 归一化） */
export interface RepoInfo {
  full_name: string
  html_url: string
  description: string
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  subscribers_count: number
  created_at: string
  pushed_at: string
  updated_at: string
  topics: string[]
  license: string | null
  homepage: string | null
  archived: boolean
  default_branch: string
  size: number
  owner: { login: string; avatar_url: string }
}

/** README 信息（详情页） */
export interface RepoReadme {
  html_url: string
  /** 原始 markdown 文本 */
  markdown: string
}

/** 最新 release（详情页） */
export interface RepoRelease {
  /** 标签名（如 v1.2.0） */
  tag_name: string
  /** release 名称 */
  name: string | null
  html_url: string
  /** 发布时间 */
  published_at: string | null
  /** 下载资产（可执行/压缩包等，不含源码包） */
  assets: { name: string; download_url: string; size: number }[]
  /** 是否 draft / prerelease */
  draft: boolean
  prerelease: boolean
}
