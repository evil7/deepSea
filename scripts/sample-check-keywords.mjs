// ---------------------------------------------------------------------------
// 关键词抽样检查脚本 —— 对每个搜索词查 top 10，评估相关性
//   用法（根目录）：
//     GITHUB_TOKEN=ghp_xxx node scripts/sample-check-keywords.mjs
//   输出：每个词一个分组，列出 top 10 仓库 full_name + description 前 60 字，
//         便于人工判断哪些词引入噪音。
//   注：GitHub Search API 匿名 10 req/min，请带 token（30 req/min）。
// ---------------------------------------------------------------------------
/* eslint-disable no-underscore-dangle */ // Node ESM 惯例 __dirname
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(
  path.join(__dirname, "..", "apps", "web", "package.json")
)
const { Octokit } = webRequire("@octokit/rest")

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error("请设置 GITHUB_TOKEN 环境变量")
  process.exit(1)
}
const octokit = new Octokit({ auth: token })

// 与 search-deepseek-repos.mjs 保持一致的关键词配置（2026-08-19 定稿：
//   topic 只保留官方指定 dsh-plugin，移除 deepc-list）
const PLUGIN_TOPICS = [
  "dsh-plugin",
]

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

/** 简单相关性判定：描述/仓库名是否命中 dsh 生态强信号 */
function relevanceScore(r) {
  const text = `${r.full_name} ${r.description ?? ""} ${(r.topics ?? []).join(" ")}`.toLowerCase()
  let score = 0
  // 强信号：明确提到 deepseek-harness / dsh 生态
  if (/deepseek[- ]harness|dsh[- ]plugin|dsh[- ]skill|dsh[- ]patch|@deepseek-ai\/dsh/.test(text)) score += 3
  // 中信号：提到 harness 插件 / cordis 生态
  if (/harness/.test(text) && /plugin|skill|agent/.test(text)) score += 2
  if (/cordis/.test(text)) score += 2
  // 弱信号：仅泛化 agent/plugin 词（可能无关）
  if (/\bagent(s)?\b/.test(text)) score += 1
  if (/\bplugin(s)?\b/.test(text)) score += 1
  return score
}

async function sample(q, label, type) {
  console.log(`\n${"═".repeat(70)}`)
  console.log(`【${type}】${label}\n  q = ${q}`)
  try {
    const res = await octokit.search.repos({
      q,
      sort: "stars",
      order: "desc",
      per_page: 10,
    })
    res.data.items.forEach((it, i) => {
      const score = relevanceScore(it)
      const flag = score >= 3 ? "✅强相关" : score >= 2 ? "🟡中相关" : "❌疑似噪音"
      console.log(
        `  ${String(i + 1).padStart(2)} [${flag}] ${it.stargazers_count} ${it.full_name}\n      ${(it.description ?? "").slice(0, 70)}`
      )
    })
  } catch (err) {
    console.log(`  ⚠ 查询失败: ${err.status ?? err.message}`)
  }
  // 节流 2.1s
  await new Promise((r) => setTimeout(r, 2100))
}

async function main() {
  console.log("关键词抽样检查（每词 top 10）")
  // 组装全部抽查任务（nameDesc → readme → topic）
  const jobs = [
    ...KEYWORD_TERMS.nameDesc.map((t) => ({
      q: `${t} in:name,description`,
      label: t,
      type: "nameDesc",
    })),
    ...KEYWORD_TERMS.readme.map((t) => ({
      q: `${t} in:readme`,
      label: t,
      type: "readme",
    })),
    ...PLUGIN_TOPICS.map((t) => ({
      q: `topic:${t}`,
      label: t,
      type: "topic",
    })),
  ]
  // Promise 链串行执行：避免 for-await-in-loop（lint 警告），同时保持每次
  // 请求后 2.1s 节流（GitHub 限流敏感，不能改为 Promise.all 并发）
  await jobs.reduce(
    (chain, job) => chain.then(() => sample(job.q, job.label, job.type)),
    Promise.resolve()
  )
  console.log("\n完成。✅ 强相关 / 🟡 中相关 / ❌ 疑似噪音")
}

main()
