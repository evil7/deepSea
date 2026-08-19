// ---------------------------------------------------------------------------
// 讨论交流 discussions 同步脚本（GraphQL）
//   抓取两个社区的 discussions 前 N 条，归一化后写入静态 JSON（前端零配额读取）：
//   · 自家社区 evil7/deepSea（可互动）      → public/data/discussions.json
//   · 官方社区 deepseek-ai/deepseek-harness → public/data/discussions-official.json
//   · GitHub GraphQL API 必须带 token 认证（匿名浏览器请求 403）
//   · 两个社区独立容错：单个失败保留旧数据，不阻塞另一个 / workflow
//
// token 区分（关键）：
//   · 自家用 GITHUB_TOKEN（Actions 自动注入，需 permissions: discussions: read）
//   · 官方用 DEEPSEA_PAT（个人 PAT，带 public_repo/repo scope）——GITHUB_TOKEN 是
//     integration token，无法读未安装 App 的外部仓库（deepseek-ai）的 discussions
//     （报 "Resource not accessible by integration"）
//
// 用法（根目录）：
//   GITHUB_TOKEN=ghp_xxx pnpm sync:discussions             # 两个社区都用 GITHUB_TOKEN
//   GITHUB_TOKEN=ghp_xxx DEEPSEA_PAT=ghp_yyy pnpm sync:discussions  # 官方用 PAT
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
          upvoteCount
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
    upvoteCount: it.upvoteCount ?? 0,
    author: it.author?.login ?? "unknown",
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
  }))
}

/** 抓取单个社区（失败返回 null，不抛错，交由调用方降级） */
async function fetchDiscussionsSafe(owner, repo, first, token) {
  try {
    return await fetchDiscussions(owner, repo, first, token)
  } catch (err) {
    console.warn(`  ⚠ ${owner}/${repo} 抓取失败：${err.message}`)
    return null
  }
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
  // 官方社区：优先 DEEPSEA_PAT（个人 PAT），回退 GITHUB_TOKEN（本地无 PAT 时）
  const officialToken = process.env.DEEPSEA_PAT || token
  const first = Number(process.argv[2] ?? 50) || 50

  console.log("octokit GraphQL 抓取两个社区 discussions…")
  // 两个社区独立容错：单个失败不阻塞另一个，也不阻塞 workflow。
  // 失败的社区保留旧数据（不写文件覆盖）。
  const [own, official] = await Promise.all([
    fetchDiscussionsSafe(OWNER, REPO, first, token),
    fetchDiscussionsSafe(OFFICIAL_OWNER, OFFICIAL_REPO, first, officialToken),
  ])

  if (own === null && official === null) {
    console.error("两个社区抓取均失败，放弃同步（保留旧数据）")
    process.exit(1)
  }

  const outDir = path.join(__dirname, "output")
  const frontendDir = path.join(
    __dirname, "..", "apps", "web", "public", "data"
  )

  console.log(`\n同步结果：`)
  if (own !== null) {
    writeJson(path.join(outDir, "discussions.json"), own)
    writeJson(path.join(frontendDir, "discussions.json"), own)
    console.log(`  自家社区 ${OWNER}/${REPO}：${own.length} 条 → discussions.json`)
    preview("自家社区", own)
  } else {
    console.warn(`  自家社区抓取失败，保留旧 discussions.json`)
  }
  if (official !== null) {
    writeJson(path.join(outDir, "discussions-official.json"), official)
    writeJson(path.join(frontendDir, "discussions-official.json"), official)
    console.log(
      `  官方社区 ${OFFICIAL_OWNER}/${OFFICIAL_REPO}：${official.length} 条 → discussions-official.json`
    )
    preview("官方社区", official)
  } else {
    console.warn(`  官方社区抓取失败，保留旧 discussions-official.json`)
  }
  console.log(`  前端种子目录：${frontendDir}`)
}

main().catch((err) => {
  console.error("抓取失败：", err.message)
  process.exit(1)
})
