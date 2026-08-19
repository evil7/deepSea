// ---------------------------------------------------------------------------
// deepseek-harness 生态搜索关键词集合（单一真源）
// 与 scripts/search-deepseek-repos.mjs 及 .github/skills/dsh-plugin-discovery 一致
// ---------------------------------------------------------------------------

export const OFFICIAL_REPOS = ["deepseek-ai/deepseek-harness"] as const

export const PLUGIN_TOPICS = [
  "dsh",
  "dsh-plugin",
  "dsh-plugins",
  "dsh-patch",
  "dsh-skill",
  "deepseek-harness",
  "deepseek-harness-plugin",
  "deepc-list",
] as const

/** 前端种子数据地址（脚本 scripts/search-deepseek-repos.mjs 同步产出） */
export const PLUGIN_SEED_URL = "/data/deepseek-harness-repos.json"
