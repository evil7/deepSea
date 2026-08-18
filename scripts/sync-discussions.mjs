// ---------------------------------------------------------------------------
// 讨论交流 discussions 同步脚本（GraphQL）
//   抓取两个社区的 discussions 前 N 条，归一化后写入静态 JSON（前端零配额读取）：
//   · 自家社区 evil7/deepSea（可互动）      → public/data/discussions.json
//   · 官方社区 deepseek-ai/deepseek-harness → public/data/discussions-official.json
//   · GitHub GraphQL API 必须带 token 认证（匿名浏览器请求 403）
//   · 由 GitHub Actions（GITHUB_TOKEN）每小时同步一次
//
// 用法（根目录）：
//   GITHUB_TOKEN=ghp_xxx pnpm sync:discussions       # 默认各拉 50 条
//   GITHUB_TOKEN=ghp_xxx pnpm sync:discussions -- 30 # 自定义条数
//
// 输出：scripts/output/*.json + 前端种子 public/data/*.json
// ---------------------------------------------------------------------------
/* eslint-disable no-underscore-dangle */ // Node ESM 惯例 __dirname
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(
  path.join(__dirname, "..", "apps", "web", "package.json")
)
const { graphql } = webRequire("@octokit/graphql")

/** 自家社区（可互动） */
const OWNER = "evil7"
const REPO = "deepSea"
/** 官方社区（只读） */
const OFFICIAL_OWNER = "deepseek-ai"
const OFFICIAL_REPO = "deepseek-harness"

const LIST_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $first: Int!) {
    repository(owner: $owner, name: $repo) {
      discussions(
        first: $first
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes {
          number
          title
          url
          category { name }
          comments { totalCount }
          author { login }
          createdAt
          updatedAt
        }
      }
    }
  }
`

async function fetchDiscussions(owner, repo, first, token) {
  const data = await graphql({
    query: LIST_QUERY,
    // @octokit/graphql v7+：对象形式将变量展开到顶层（variables 键已弃用）
    owner,
    repo,
    first,
    headers: { authorization: `Bearer ${token}` },
  })
  const nodes = data.repository?.discussions?.nodes ?? []
  return nodes.map((it) => ({
    number: it.number,
    title: it.title,
    url: it.url,
    categoryName: it.category?.name ?? "未分类",
    comments: it.comments?.totalCount ?? 0,
    author: it.author?.login ?? "unknown",
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
  }))
}

function writeJson(filePath, list) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8")
}

function preview(label, list) {
  if (!list.length) {
    console.log(`  ${label}：暂无讨论`)
    return
  }
  console.log(`  ${label}：`)
  list.slice(0, 5).forEach((d, i) => {
    console.log(
      `    ${String(i + 1).padStart(2)} [#${d.number}] ${d.title.slice(0, 50)}` +
        `（${d.categoryName} · ${d.comments} 评论 · ${d.author}）`
    )
  })
  if (list.length > 5) {
    console.log(`    …（还有 ${list.length - 5} 条）`)
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error("请设置 GITHUB_TOKEN 环境变量（GitHub GraphQL 必须带 token 认证）")
    process.exit(1)
  }
  const first = Number(process.argv[2] ?? 50) || 50

  console.log("octokit GraphQL 抓取两个社区 discussions…")
  const [own, official] = await Promise.all([
    fetchDiscussions(OWNER, REPO, first, token),
    fetchDiscussions(OFFICIAL_OWNER, OFFICIAL_REPO, first, token),
  ])

  const outDir = path.join(__dirname, "output")
  const frontendDir = path.join(
    __dirname, "..", "apps", "web", "public", "data"
  )
  writeJson(path.join(outDir, "discussions.json"), own)
  writeJson(path.join(outDir, "discussions-official.json"), official)
  writeJson(path.join(frontendDir, "discussions.json"), own)
  writeJson(path.join(frontendDir, "discussions-official.json"), official)

  console.log(`\n同步完成：`)
  console.log(`  自家社区 ${OWNER}/${REPO}：${own.length} 条 → discussions.json`)
  console.log(
    `  官方社区 ${OFFICIAL_OWNER}/${OFFICIAL_REPO}：${official.length} 条 → discussions-official.json`
  )
  console.log(`  前端种子目录：${frontendDir}\n`)

  preview("自家社区", own)
  preview("官方社区", official)
}

main().catch((err) => {
  console.error("抓取失败：", err.message)
  process.exit(1)
})
