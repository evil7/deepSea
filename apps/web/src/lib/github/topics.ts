// ---------------------------------------------------------------------------
// deepseek-harness 生态搜索关键词集合（单一真源）
// 与 scripts/search-deepseek-repos.mjs 及 .github/skills/dsh-plugin-discovery 一致
// ---------------------------------------------------------------------------

export const OFFICIAL_REPOS = ["deepseek-ai/deepseek-harness"] as const

// 生态收录 topic（2026-08-19 定稿）：只保留官方指定 topic `dsh-plugin`。
// deepc-list 等自定义 topic 暂不收录，等 deepc 插件开发完成后再敲定与增补。
export const PLUGIN_TOPICS = [
  "dsh-plugin",
] as const

/** 前端种子数据地址（脚本 scripts/search-deepseek-repos.mjs 同步产出） */
export const PLUGIN_SEED_URL = "/data/deepseek-harness-repos.json"
