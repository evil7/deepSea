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
//   pnpm search:plugins -- --sort updated --limit 200  # 按更新时间、每类型最多 200 条（默认 1000）
//   pnpm search:plugins -- --concurrency 10            # 并发查询数（默认 6，受 30 req/min 限速）
//   pnpm search:plugins -- --merge                     # 拼接输出目录下其它 JSON 结果
//   pnpm search:plugins -- --out data/repos.json       # 自定义输出路径
//   pnpm search:plugins -- --topics-only               # 只跑 topic 搜索
//   pnpm search:plugins -- --readme                    # 额外收录 README 全文命中
//   pnpm search:plugins -- -v                          # 打印每轮查询进度
//
// 默认缓存参数：limit 1000/类型（拉满单查询上限），star ≥ 10，创建时间距今 ≥ 5 天（质量门槛）。
// 专属收录：带 deepc-list topic 的仓库无条件收录（跳过 star/age 门槛）。
// 关键词精选 6 个核心词（1 组 OR 查询；追加时自动拆分，至多 12 个分 2 次）。
//
// 搜索优化（减少请求、防触顶、提速）：
//   · 关键词按 OR 合并分组（每 6 term 一组 = GitHub 单查询布尔上限）
//   · topic 无法合并（qualifier 不支持 OR，422），保持逐条
//   · 并发：多查询并行执行（--concurrency，默认 6），全局限速器保证不超过
//     官方 30 req/min（请求间隔 ≥2s），但请求发出后不等响应（流水线）——
//     把网络等待时间隐藏，总墙钟时间 ≈ 请求数/30/min，而非串行累加
//   · 每查询 per_page=100（单次最大分页）+ 按 --limit 自动翻页递归，
//     配额见底自动停止；403/429 保留已收结果不中断
//   · --merge：拼接 scripts/output/ 下其它结果 JSON（多配置跑出的文件合并）
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
// 注意（2026-08-19 收紧）：
//   · 已移除 cordis / cordis-plugin —— cordis 是 Koishi 框架的通用插件机制，
//     topic:cordis 会引入大量纯 cordis 项目（shikitor 编辑器、SILI-agent
//     聊天机器人、inpageedit wiki 编辑器等），与 dsh 生态无关。真正的 dsh
//     插件必然同时打 dsh/dsh-plugin topic，去掉 cordis 不影响收录。
//   · 已移除 plugin-marketplace / plugin-store（泛化“插件市场”主题，Claude /
//     通用插件生态仓库大量混入）。
//   · deepc-list —— 生态约定 topic：插件开发者若希望自己的插件库被 deepSea
//     主动收录，可为仓库打上 `deepc-list` topic。deepSea 据此收录并展示。
//   · 只保留 dsh 专属 topic，从源头杜绝无关项目混入。
const PLUGIN_TOPICS = [
  "dsh",
  "dsh-plugin",
  "dsh-plugins",
  "dsh-patch",
  "dsh-skill",
  "deepseek-harness",
  "deepseek-harness-plugin",
  "deepc-list",
]

// 关键词精选（name/description 命中）：
//   精选最匹配的核心关键词（默认 1 组查询；追加更多时自动按每组 ≤6 个
//   term 拆成多次 OR 查询，至多 12 个）。GitHub 单查询最多 5 个布尔运算符。
//   关键：term 必须用引号包裹（含空格/连字符的短语），否则 GitHub 的
//   OR 优先级高于 AND，会把多词 term 拆成单次 OR（如 deepseek agent →
//   deepseek OR agent），导致任何描述含 agent/harness/plugin 的无关仓库
//   混入收录。
//   ⚠️ 2026-08-19 移除裸 "dsh" 与 "harness plugin"：
//   · "dsh" 是子串匹配，会撞上 Box2DSharp / DShot / DShield / 3DShape /
//     DShimmer / d2dsharp 等海量含 "dsh" 字母的无关项目（NOT 无法枚举干净）。
//   · "harness plugin" 太宽，命中各种 AI agent harness 插件。
//   · 只保留 dsh 专属长词，确保收录精准。
const KEYWORD_TERMS = {
  nameDesc: [
    '"deepseek-harness"',
    '"deepseek harness"',
    '"dsh-plugin"',
    '"dsh-plugins"',
    '"dsh-patch"',
    '"deepseek-harness plugin"',
  ],
  readme: [
    '"deepseek-harness"',
    '"deepseek harness"',
    '"dsh-plugin"',
    '"@deepseek-ai/dsh"',
  ],
}

// GitHub Search 布尔运算符上限：5 个 OR = 6 个 term 为一组。
// 注意：含 NOT 的 term（如 "dsh" NOT Dshell NOT DsHidMini）会额外占用
// 2 个运算符，故每组最大有效 term 数需按运算符数重新计算：
//   · 普通 term 组：≤6 term（5 个 OR）
//   · 含 1 个 NOT 的 term：相当于 3 个运算符（1 AND + 2 NOT），该组最多容纳
//     2 个 term（1 OR + 2 NOT = 3）
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

// ---------------------------------------------------------------------------
// 并发 + 全局限速
//   GitHub Search API 带 token 30 req/min（匿名 10/min）。串行实现每请求后
//   睡 2.1s，但响应等待时间也白白流逝。这里用「限速器 + 并发池」：
//     · SearchThrottle：全局串行占坑，保证任意两次「请求发起」间隔 ≥ interval，
//       但发起后不等响应 —— 流水线，多个查询并行翻页
//     · runPool：固定并发 worker 跑任务数组，每个任务自行过限速器
//   总墙钟时间 ≈ 请求总数 × interval（而非串行累加响应等待）
// ---------------------------------------------------------------------------
class SearchThrottle {
  constructor(intervalMs) {
    this.intervalMs = intervalMs
    this.last = 0
    this.tail = Promise.resolve()
  }

  /** 排队直到允许发起下一个请求（串行占坑；发起后调用方自行 await 响应） */
  async acquire() {
    let release
    const prev = this.tail
    this.tail = new Promise((r) => (release = r))
    await prev
    try {
      const now = Date.now()
      const wait = Math.max(0, this.intervalMs - (now - this.last))
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait))
      }
      this.last = Date.now()
    } finally {
      release()
    }
  }
}

/** 并发池：固定 worker 数执行任务数组（结果按原序；异常以 Error 值返回） */
async function runPool(tasks, concurrency) {
  const results = Array.from({ length: tasks.length })
  let next = 0
  const worker = async () => {
    // 并发池 worker：各 worker 并行消费独立任务队列，await 合法（非串行依赖）
    /* eslint-disable no-await-in-loop */
    for (;;) {
      const i = next++
      if (i >= tasks.length) {
        return
      }
      try {
        results[i] = await tasks[i]()
      } catch (err) {
        results[i] = err
      }
    }
    /* eslint-enable no-await-in-loop */
  }
  const n = Math.max(1, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

/**
 * 关键词拆组（运算符感知）：term 内含 NOT 的单独成组，避免整组超 5 运算符。
 * GitHub 单查询最多 5 个 AND/OR/NOT：
 *   · 普通 term：6 个 OR 连接（5 运算符）
 *   · 含 1 个 NOT 的 term："a" NOT b NOT c = 2 个 NOT + 0 个 OR = 2 运算符，
 *     单独成组最安全（不与其他 term 混 OR）
 */
function splitKeywordGroups(terms, qualifier) {
  const plain = terms.filter((t) => !/\sNOT\s/i.test(t))
  const withNot = terms.filter((t) => /\sNOT\s/i.test(t))
  const groups = []
  for (let i = 0; i < plain.length; i += MAX_OR_TERMS) {
    const chunk = plain.slice(i, i + MAX_OR_TERMS)
    groups.push(`${chunk.join(" OR ")} ${qualifier}`)
  }
  for (const t of withNot) {
    groups.push(`${t} ${qualifier}`)
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
    // 缓存默认每类型 1000 个（关键词组 / 每个 topic 各 1000，即拉满）
    limit: 1000,
    out: path.join(__dirname, "output", "deepseek-harness-repos.json"),
    topicsOnly: false,
    readme: false,
    verbose: false,
    // 并发查询数：多查询并行翻页（全局限速保证 30 req/min 不超限）
    concurrency: 6,
    // 拼接输出目录下其它 JSON 结果（多配置文件合并去重）
    merge: false,
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
    else if (a === "--concurrency") args.concurrency = Number(next()) || 6
    else if (a.startsWith("--concurrency=")) args.concurrency = Number(a.slice(15)) || 6
    else if (a === "--merge") args.merge = true
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
    queries.push(...splitKeywordGroups(KEYWORD_TERMS.nameDesc, "in:name,description"))
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
// 并发模式下由全局 SearchThrottle 控制发起间隔（流水线，不等响应）。
async function searchQuery(octokit, q, { sort, limit, verbose }, throttle) {
  const results = []
  // 单次最大分页（GitHub Search 上限 100/请求）
  const perPage = Math.min(limit, 100)
  const maxPages = Math.ceil(limit / perPage)
  let total = Infinity
  let remain = Infinity
  // 分页串行（同一查询内页序相关），但每页请求都过全局限速器；
  // 多个查询并发翻页时由 throttle 统一排程，保证 30 req/min 不超限
  /* eslint-disable no-await-in-loop */
  for (let page = 1; page <= maxPages; page++) {
    let res
    try {
      await throttle.acquire() // 全局请求间隔（token 2000ms / 匿名 6000ms）
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
      // 带 deepc-list topic → 无条件收录（跳过 star/age 质量门槛）
      is_deepc_list: Array.isArray(it.topics) && it.topics.includes("deepc-list"),
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
    `minStars=${args.minStars} minAgeDays=${args.minAgeDays} sort=${args.sort} ` +
    `limit=${args.limit} concurrency=${args.concurrency}`)

  const octokit = new Octokit({ auth: args.token || undefined })

  const queries = buildQueries(args)
  // 全局限速：带 token 30 req/min（间隔 2s）；匿名 10 req/min（间隔 6s）
  const throttle = new SearchThrottle(args.token ? 2000 : 6000)
  console.log(
    `\n执行 ${queries.length} 组查询（并发 ${args.concurrency}，` +
      `限速 ${args.token ? 30 : 10} req/min）…`
  )

  const seen = new Map()
  // 并发执行：每个查询一个任务，内部自行过全局限速器；403/429 以 Error 值返回
  const tasks = queries.map((q) => async () => {
    const items = await searchQuery(octokit, q, args, throttle)
    const src = q.startsWith("topic:") ? "topic" : "keyword"
    return {
      q,
      items: items.map((it) => Object.assign({}, it, { sources: [src] })),
    }
  })
  const results = await runPool(tasks, args.concurrency)
  let rateLimited = false
  for (const r of results) {
    if (r instanceof Error) {
      if (r.status === 403 || r.status === 429) {
        rateLimited = true
        console.warn(`\n⚠ 限流（${r.status}）：部分查询未完成。请设置 GITHUB_TOKEN 提高配额。`)
      } else {
        console.warn(`\n⚠ 查询失败：${r.message}`)
      }
      continue
    }
    const merged = aggregate(r.items, seen)
    seen.clear()
    for (const [k, v] of merged) seen.set(k, v)
  }
  if (rateLimited) {
    await logRateLimit(octokit)
  }

  // —— 拼接：合并输出目录下其它结果 JSON（--merge；多配置跑出的文件去重合并）——
  if (args.merge) {
    const dir = path.dirname(args.out)
    if (fs.existsSync(dir)) {
      const self = path.resolve(args.out)
      const others = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json") && path.resolve(dir, f) !== self)
      for (const f of others) {
        try {
          const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))
          if (Array.isArray(arr)) {
            const tagged = arr.map((it) =>
              Object.assign({}, it, { sources: it.sources ?? ["merge"] })
            )
            const merged = aggregate(tagged, seen)
            seen.clear()
            for (const [k, v] of merged) seen.set(k, v)
            console.log(`  拼接 ${f}（+${arr.length} 条）`)
          }
        } catch {
          console.warn(`  ⚠ 跳过无法解析的 ${f}`)
        }
      }
    }
  }

  // —— 过滤（质量门槛：star / 创建时间距今；官方库与 deepc-list 始终保留）+ 排序 ——
  const minAgeMs = args.minAgeDays * 86400000
  const repos = [...seen.values()]
    .filter(
      (r) =>
        r.is_deepc_list ||
        r.stargazers_count >= args.minStars ||
        OFFICIAL_REPOS.has(r.full_name)
    )
    .filter((r) => {
      // 官方库与 deepc-list 仓库豁免发布时间门槛（无条件收录）
      if (OFFICIAL_REPOS.has(r.full_name) || r.is_deepc_list) {
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
