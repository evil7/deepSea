// ---------------------------------------------------------------------------
// deepseek-harness 生态仓库搜索/收集脚本
//   使用 octokit REST Search API 搜索所有 deepseek-harness 相关 GitHub 仓库，
//   聚合 topic 搜索 + 关键词搜索，按 full_name 去重，导出结构化 JSON。
//
// 依赖复用：不重复安装 octokit —— 通过 createRequire 引用 apps/web 的
//   @octokit/rest（pnpm workspace 已安装）。
//
// 用法（根目录）：
//   GITHUB_TOKEN=ghp_xxx pnpm search:plugins          # 带 token（限流 30/min）
//   pnpm search:plugins -- --min-stars 0               # 放宽 star 门槛（默认 ≥10）
//   pnpm search:plugins -- --min-age-days 0            # 关闭发布时间门槛（默认 ≥5 天）
//   pnpm search:plugins -- --sort updated --limit 200  # 按更新时间、每类型最多 200 条（默认 500）
//   pnpm search:plugins -- --out data/repos.json       # 自定义输出路径
//   pnpm search:plugins -- --topics-only               # 只跑 topic 搜索
//   pnpm search:plugins -- --readme                    # 额外收录 README 全文命中
//   pnpm search:plugins -- -v                          # 打印每轮查询进度
//
// 默认缓存参数：limit 500/类型，star ≥ 10，创建时间距今 ≥ 5 天（质量门槛）。
// 关键词精选 6 个核心词（1 组 OR 查询；追加时自动拆分，至多 12 个分 2 次）。
//
// 搜索优化（减少请求、防触顶）：
//   · 关键词按 OR 合并分组（每 6 term 一组 = GitHub 单查询布尔上限）
//   · topic 无法合并（qualifier 不支持 OR，422），保持逐条 11 次
//   · 每查询 per_page=100（单次最大分页）+ 按 --limit 自动翻页递归，
//     2.1s 节流 + 配额见底自动停止；403/429 保留已收结果不中断
//
// 输出：scripts/output/deepseek-harness-repos.json + 前端种子 public/data/...json
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

// ══════════════════════════════════════════════════════════════════════════
// ① 可定制搜索配置 —— 只改这里即可调整收录范围，无需触碰下方逻辑
// ══════════════════════════════════════════════════════════════════════════

// 官方库：置顶展示并标记 is_official: true
const OFFICIAL_REPOS = new Set(["deepseek-ai/deepseek-harness"])

// Topic 全量收录：GitHub Search 不支持对 qualifier（如 topic:）使用 OR
// （422：Logical operators only apply to text），必须逐条查询。
// 新增生态 topic 直接追加到数组即可。
// 注意：cordis 为 dsh 核心依赖（everything is a plugin），其插件生态与 dsh
//       兼容；但 ai-agents / agent-harness 等泛 AI 主题会引入大量无关噪音，
//       不建议收录（噪音会淹没真正的 dsh 插件）。
const PLUGIN_TOPICS = [
  "dsh",
  "dsh-plugin",
  "dsh-plugins",
  "dsh-patch",
  "dsh-skill",
  "deepseek-harness",
  "deepseek-harness-plugin",
  "cordis",
  "cordis-plugin",
  "plugin-marketplace",
  "plugin-store",
]

// 关键词精选（name/description 命中）：
//   精选最匹配的 6 个核心关键词（默认 1 组查询；追加更多时自动按每组 ≤6 个
//   term 拆成两次 OR 查询，至多 12 个）。GitHub 单查询最多 5 个布尔运算符。
//   关键：term 必须用引号包裹（含空格/连字符的短语），否则 GitHub 的
//   OR 优先级高于 AND，会把多词 term 拆成单次 OR（如 deepseek agent →
//   deepseek OR agent），导致任何描述含 agent/harness/plugin 的无关仓库
//   混入收录（ohmyzsh、vim-plug 等 star 巨头）。
const KEYWORD_TERMS = {
  nameDesc: [
    '"deepseek-harness"',
    '"deepseek harness"',
    '"dsh"',
    '"dsh-plugin"',
    '"deepseek-harness plugin"',
    '"harness plugin"',
  ],
  readme: [
    '"deepseek-harness"',
    '"deepseek harness"',
    '"dsh-plugin"',
    '"@deepseek-ai/dsh"',
  ],
}

// GitHub Search 布尔运算符上限：5 个 OR = 6 个 term 为一组
const MAX_OR_TERMS = 6

/** 把 term 列表按每组 ≤6 个拆组，用 OR 合并为查询字符串 */
function groupByOr(terms, qualifier) {
  const groups = []
  for (let i = 0; i < terms.length; i += MAX_OR_TERMS) {
    const chunk = terms.slice(i, i + MAX_OR_TERMS)
    groups.push(`${chunk.join(" OR ")} ${qualifier}`)
  }
  return groups
}

// ══════════════════════════════════════════════════════════════════════════
// ② CLI 参数解析
// ══════════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const args = {
    token: process.env.GITHUB_TOKEN,
    // 缓存默认质量门槛：star ≥ 10、创建时间距今 ≥ 5 天（排除刷星/垃圾新库）
    minStars: 10,
    minAgeDays: 5,
    sort: "stars", // stars | updated | created
    // 单查询收录上限：GitHub Search API 每查询最多返回 1000 条
    // 缓存默认每类型 500 个（关键词组 / 每个 topic 各 500）
    limit: 500,
    out: path.join(__dirname, "output", "deepseek-harness-repos.json"),
    topicsOnly: false,
    readme: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--token") args.token = next()
    else if (a.startsWith("--token=")) args.token = a.slice(8)
    else if (a === "--min-stars") args.minStars = Number(next()) || 0
    else if (a.startsWith("--min-stars=")) args.minStars = Number(a.slice(12)) || 0
    else if (a === "--min-age-days") args.minAgeDays = Number(next()) || 0
    else if (a.startsWith("--min-age-days=")) args.minAgeDays = Number(a.slice(15)) || 0
    else if (a === "--sort") args.sort = next()
    else if (a.startsWith("--sort=")) args.sort = a.slice(7)
    else if (a === "--limit") args.limit = Number(next()) || 1000
    else if (a.startsWith("--limit=")) args.limit = Number(a.slice(8)) || 1000
    else if (a === "--out") args.out = next()
    else if (a.startsWith("--out=")) args.out = a.slice(6)
    else if (a === "--topics-only") args.topicsOnly = true
    else if (a === "--readme") args.readme = true
    else if (a === "--verbose" || a === "-v") args.verbose = true
  }
  return args
}

// —— 构造查询集合 ——
// 关键词：按 OR 合并分组（每 6 term 一组，节约请求）；topic 逐条。
// 注意：GitHub Search 的 OR 只能用于文本，不能用于 qualifier（topic: 等），
//       且单查询最多 5 个布尔运算符（6 个 term）。匿名 10/min 建议带 token。
function buildQueries({ topicsOnly, readme }) {
  const queries = []
  if (!topicsOnly) {
    queries.push(...groupByOr(KEYWORD_TERMS.nameDesc, "in:name,description"))
    if (readme) {
      queries.push(...groupByOr(KEYWORD_TERMS.readme, "in:readme"))
    }
  }
  queries.push(...PLUGIN_TOPICS.map((t) => `topic:${t}`))
  return queries
}

// —— 搜索执行：按实际 limit 自动分页递归拉取 ——
// 始终翻页直到满足以下任一条件：取满 limit、翻完 total_count、配额见底。
// GitHub Search API：每查询最多返回 1000 条、带 token 30 req/min；
// 分页间节流 + 检查 x-ratelimit-remaining，避免 403 截断。
async function searchQuery(octokit, q, { sort, limit, verbose }) {
  const results = []
  // 单次最大分页（GitHub Search 上限 100/请求）
  const perPage = Math.min(limit, 100)
  const maxPages = Math.ceil(limit / perPage)
  let total = Infinity
  let remain = Infinity
  // 分页必须串行（限流敏感），非并行 Promise.all
  /* eslint-disable no-await-in-loop */
  for (let page = 1; page <= maxPages; page++) {
    let res
    try {
      res = await octokit.search.repos({
        q,
        sort,
        order: "desc",
        per_page: perPage,
        page,
      })
    } catch (err) {
      // 限流（403/429）：保留已收集结果，交由上层继续/停止，不抛断整体
      if (err.status === 403 || err.status === 429) {
        if (verbose) {
          console.log(
            `  ⚠ 限流（${err.status}）：本查询已取 ${results.length} 条，停止分页`
          )
        }
        break
      }
      throw err
    }
    const items = res.data.items ?? []
    total = res.data.total_count ?? items.length
    results.push(...items)
    // 配额感知：剩余不足 10 次则停止分页（留给后续查询 / 下轮同步）
    const header = res.headers?.["x-ratelimit-remaining"]
    if (header !== undefined) {
      remain = Number(header)
    }
    if (remain <= 10) {
      if (verbose) {
        console.log(`  ⚠ 剩余配额 ${remain}，停止分页（已取 ${results.length} 条）`)
      }
      break
    }
    // 最后一页 / 取满 limit / 翻完 total_count → 结束
    if (
      items.length < perPage ||
      results.length >= limit ||
      results.length >= total
    ) {
      break
    }
    // 分页节流：GitHub Search 带 token 30 req/min 上限（每请求 ≥2s），
    // 多页递归拉取时保持稳定不撞 403；配额见底由上方检查兜底
    await new Promise((r) => setTimeout(r, 2100))
  }
  /* eslint-enable no-await-in-loop */
  if (verbose) {
    const qShort = q.length > 60 ? `${q.slice(0, 60)}…` : q
    console.log(`  [${results.length}/${Math.min(total, limit)}] ${qShort}`)
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
    `minStars=${args.minStars} minAgeDays=${args.minAgeDays} sort=${args.sort} limit=${args.limit}`)

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

  // —— 过滤（质量门槛：star / 创建时间距今；官方库始终保留）+ 排序 ——
  const minAgeMs = args.minAgeDays * 86400000
  const repos = [...seen.values()]
    .filter(
      (r) =>
        r.stargazers_count >= args.minStars ||
        OFFICIAL_REPOS.has(r.full_name)
    )
    .filter((r) => {
      // 官方库豁免发布时间门槛（避免生态锚点被质量过滤误伤）
      if (OFFICIAL_REPOS.has(r.full_name)) {
        return true
      }
      if (!args.minAgeDays || !r.created_at) {
        return !args.minAgeDays // 无创建时间且要求年龄时剔除
      }
      return Date.now() - Date.parse(r.created_at) >= minAgeMs
    })
    .toSorted((a, b) => {
      if (args.sort === "updated") return (b.pushed_at ?? "").localeCompare(a.pushed_at ?? "")
      if (args.sort === "created") return (b.created_at ?? "").localeCompare(a.created_at ?? "")
      return b.stargazers_count - a.stargazers_count
    })
    // 官方库置顶
    .toSorted((a, b) => Number(b.is_official) - Number(a.is_official))

  // 输出文件（默认 scripts/output/...json + 前端种子 public/data/...json）
  const frontendSeed = path.join(
    __dirname, "..", "apps", "web", "public", "data", "deepseek-harness-repos.json"
  )
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify(repos, null, 2), "utf-8")
  fs.mkdirSync(path.dirname(frontendSeed), { recursive: true })
  fs.writeFileSync(frontendSeed, JSON.stringify(repos, null, 2), "utf-8")

  // 终端摘要
  console.log(`\n共收集 ${repos.length} 个仓库 → ${args.out}`)
  console.log(`  前端种子同步 → ${frontendSeed}\n`)
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
