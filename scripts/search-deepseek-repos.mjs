// ---------------------------------------------------------------------------
// deepseek-harness 生态仓库搜索/收集脚本（测试用）
//   使用 octokit REST Search API 搜索所有 deepseek-harness 相关 GitHub 仓库，
//   聚合 topic 搜索 + 关键词搜索，按 full_name 去重，导出结构化 JSON。
//
// 依赖复用：不重复安装 octokit —— 通过 createRequire 引用 apps/web 的
//   @octokit/rest（pnpm workspace 已安装）。
//
// 用法（根目录）：
//   GITHUB_TOKEN=ghp_xxx pnpm search:plugins          # 带 token（限流 30/min）
//   pnpm search:plugins -- --min-stars 5               # 只收 star >= 5
//   pnpm search:plugins -- --sort updated --limit 200  # 按更新时间、最多 200 条
//   pnpm search:plugins -- --out data/repos.json       # 自定义输出路径
//   pnpm search:plugins -- --deep                      # 对每个查询分页拉全量
//   pnpm search:plugins -- --topics-only               # 只跑 topic 搜索
//
// 输出：scripts/output/deepseek-harness-repos.json + 终端摘要表
// ---------------------------------------------------------------------------
/* eslint-disable no-underscore-dangle */ // Node ESM 惯例 __dirname
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 复用 apps/web 的 @octokit/rest（pnpm 已装，避免根目录重复安装）
const webRequire = createRequire(
  path.join(__dirname, "..", "apps", "web", "package.json")
)
const { Octokit } = webRequire("@octokit/rest")

// —— 官方库与生态关键词（与 .github/skills/dsh-plugin-discovery 一致）——
const OFFICIAL_REPOS = new Set(["deepseek-ai/deepseek-harness"])

const PLUGIN_TOPICS = [
  "dsh",
  "dsh-plugin",
  "dsh-plugins",
  "dsh-patch",
  "dsh-skill",
  "deepseek-harness",
  "deepseek-harness-plugin",
  "cordis-plugin",
  "plugin-marketplace",
  "plugin-store",
]

// 关键词查询（name/description 命中）
const KEYWORD_QUERIES = [
  'deepseek-harness in:name,description',
  'deepseek-harness plugin in:name,description',
  '"deepseek harness" in:name,description',
]

// —— CLI 参数解析 ——
function parseArgs(argv) {
  const args = {
    token: process.env.GITHUB_TOKEN,
    minStars: 0,
    sort: "stars", // stars | updated | created
    limit: 100,
    out: path.join(__dirname, "output", "deepseek-harness-repos.json"),
    deep: false,
    topicsOnly: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--token") args.token = next()
    else if (a.startsWith("--token=")) args.token = a.slice(8)
    else if (a === "--min-stars") args.minStars = Number(next()) || 0
    else if (a.startsWith("--min-stars=")) args.minStars = Number(a.slice(12)) || 0
    else if (a === "--sort") args.sort = next()
    else if (a.startsWith("--sort=")) args.sort = a.slice(7)
    else if (a === "--limit") args.limit = Number(next()) || 100
    else if (a.startsWith("--limit=")) args.limit = Number(a.slice(8)) || 100
    else if (a === "--out") args.out = next()
    else if (a.startsWith("--out=")) args.out = a.slice(6)
    else if (a === "--deep") args.deep = true
    else if (a === "--topics-only") args.topicsOnly = true
    else if (a === "--verbose" || a === "-v") args.verbose = true
  }
  return args
}

// —— 构造查询集合 ——
// 注意：GitHub Search API 不支持 topic:a OR topic:b 这种 OR 合并（返回空），
//       因此 topic 逐条查询；匿名 10/min 下 10 个 topic 会顶到限流，
//       建议设置 GITHUB_TOKEN（30/min）。-v 可观察每轮进度。
function buildQueries({ topicsOnly }) {
  const queries = []
  if (!topicsOnly) {
    queries.push(...KEYWORD_QUERIES)
  }
  queries.push(...PLUGIN_TOPICS.map((t) => `topic:${t}`))
  return queries
}

// —— 搜索执行（单查询：默认取第一页；--deep 分页拉全量）——
async function searchQuery(octokit, q, { sort, limit, deep, verbose }) {
  const results = []
  if (deep) {
    // 分页拉全量（注意限流；建议带 token）
    await octokit.paginate(
      octokit.search.repos,
      { q, sort, order: "desc", per_page: 100 },
      (response) => {
        for (const item of response.data) {
          results.push(item)
        }
        // 达到 limit 或最后一页时停止
        if (results.length >= limit) {
          return { data: [] }
        }
        return response.data
      }
    )
  } else {
    const res = await octokit.search.repos({
      q,
      sort,
      order: "desc",
      per_page: Math.min(limit, 100),
    })
    results.push(...res.data.items)
  }
  if (verbose) {
    const qShort = q.length > 60 ? `${q.slice(0, 60)}…` : q
    console.log(`  [${results.length}] ${qShort}`)
  }
  return results
}

// —— 聚合：去重 + 字段精简 + 官方标记 ——
function aggregate(items, seen) {
  const merged = new Map(seen)
  for (const it of items) {
    if (merged.has(it.full_name)) {
      // 合并 topics（多查询命中时补全标签）
      const prev = merged.get(it.full_name)
      prev.topics = [...new Set([...(prev.topics ?? []), ...(it.topics ?? [])])]
      continue
    }
    merged.set(it.full_name, {
      full_name: it.full_name,
      html_url: it.html_url,
      description: it.description ?? "",
      language: it.language ?? null,
      stargazers_count: it.stargazers_count ?? 0,
      forks_count: it.forks_count ?? 0,
      open_issues_count: it.open_issues_count ?? 0,
      created_at: it.created_at ?? null,
      pushed_at: it.pushed_at ?? null,
      updated_at: it.updated_at ?? null,
      topics: it.topics ?? [],
      license: it.license?.spdx_id ?? null,
      archived: it.archived ?? false,
      is_official: OFFICIAL_REPOS.has(it.full_name),
      // 命中关键词：记录来源（topic / keyword），便于追溯
      sources: [it.sources?.[0] ?? "search"],
    })
  }
  return merged
}

// —— rate limit 提示 ——
async function logRateLimit(octokit) {
  try {
    const rl = await octokit.request("GET /rate_limit")
    const core = rl.data.resources.core
    console.log(
      `  剩余配额: ${core.remaining}/${core.limit}（重置 ${new Date(core.reset * 1000).toLocaleTimeString()}）`
    )
  } catch {
    // 忽略：配额不可用时跳过
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(`octokit 仓库搜索：token=${args.token ? "已提供" : "匿名"} ` +
    `minStars=${args.minStars} sort=${args.sort} limit=${args.limit} deep=${args.deep}`)

  const octokit = new Octokit({ auth: args.token || undefined })

  const queries = buildQueries(args)
  console.log(`\n执行 ${queries.length} 组查询…`)

  const seen = new Map()
  // 顺序执行（不可并行：GitHub Search 限流严格，串行才能稳定 30 req/min）
  /* eslint-disable no-await-in-loop */
  for (const q of queries) {
    try {
      const items = await searchQuery(octokit, q, args)
      const src = q.startsWith("topic:") ? "topic" : "keyword"
      const tagged = items.map((it) => Object.assign({}, it, { sources: [src] }))
      const merged = aggregate(tagged, seen)
      seen.clear()
      for (const [k, v] of merged) seen.set(k, v)
    } catch (err) {
      if (err.status === 403 || err.status === 429) {
        console.warn(`\n⚠ 限流（${err.status}）：停止后续查询。请设置 GITHUB_TOKEN 提高配额。`)
        await logRateLimit(octokit)
        break
      }
      console.warn(`\n⚠ 查询失败：${q}\n  ${err.message}`)
    }
  }
  /* eslint-enable no-await-in-loop */

  // —— 过滤 + 排序 ——
  const repos = [...seen.values()]
    .filter((r) => r.stargazers_count >= args.minStars)
    .toSorted((a, b) => {
      if (args.sort === "updated") return (b.pushed_at ?? "").localeCompare(a.pushed_at ?? "")
      if (args.sort === "created") return (b.created_at ?? "").localeCompare(a.created_at ?? "")
      return b.stargazers_count - a.stargazers_count
    })
    // 官方库置顶
    .toSorted((a, b) => Number(b.is_official) - Number(a.is_official))

  // 输出文件
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify(repos, null, 2), "utf-8")

  // 终端摘要
  console.log(`\n共收集 ${repos.length} 个仓库 → ${args.out}\n`)
  console.table(
    repos.slice(0, 20).map((r) => ({
      repo: r.full_name,
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language ?? "-",
      pushed: (r.pushed_at ?? "").slice(0, 10),
      official: r.is_official ? "✓" : "",
      source: [...new Set(r.sources)].join(","),
    }))
  )
  if (repos.length > 20) {
    console.log(`…（还有 ${repos.length - 20} 个，见 JSON 文件）`)
  }
  await logRateLimit(octokit)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
