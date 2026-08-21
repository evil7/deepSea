/* eslint-disable no-underscore-dangle */ // Node ESM 惯例 __dirname
// ---------------------------------------------------------------------------
// cache 分支发布脚本（洁癖单 commit）
//   把 scripts/output/*.json 发布到 git 的 `cache` 孤儿分支（无 parent、独立历史）。
//
//   「洁癖更新」：每次用 git worktree 建孤儿分支 → 复制数据 → 单 commit →
//   `git push origin cache --force` 覆盖远端，cache 分支永远只有 1 个 commit。
//
//   cache 分支内容：孤儿 worktree 工作树初始为空，只把 3 个 json 复制到根目录，
//   **不放任何代码文件**。commit 信息统一为 `cached at <ISO时间>`。
//
//   前端通过 raw.githubusercontent.com/{owner}/{repo}/cache/<file> 读取（零 API
//   配额 + CORS 允许），失败回退仓库 /data/*.json。详见 tmp/deepsea-cache-branch.md。
//
// 用法（根目录）：
//   pnpm publish:cache                      # 把 scripts/output 现有 JSON 发布到 cache
//   pnpm sync:cache                         # 抓插件 + 讨论 + 发布（一键）
//
// 认证：本地依赖 git 已配置的 SSH remote；Actions 里 checkout 已注入 GITHUB_TOKEN，
//   `git push` 直接可用，无需在此脚本处理凭据。
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, "..")
const BRANCH = "cache"
const WORKTREE = ".cache-worktree" // 仓库根下的临时 worktree 目录（已 gitignore）
const WT_PATH = path.join(REPO_ROOT, WORKTREE)
const OUT_DIR = path.join(__dirname, "output")

/** 发布的缓存文件（与前端 cache.ts 的 CACHE_FILES 一一对应） */
const FILES = [
  "deepseek-harness-repos.json",
  "discussions.json",
  "discussions-official.json",
]

/** 执行 git（cwd 默认仓库根；返回 stdout；失败抛错） */
function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/** 执行 git 但忽略失败（幂等清理用） */
function tryGit(args, cwd = REPO_ROOT) {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

function main() {
  // ① 幂等清理：移除残留 worktree + 删除本地 cache 分支（洁癖重建）
  tryGit(["worktree", "remove", "--force", WT_PATH])
  tryGit(["branch", "-D", BRANCH])

  // ② 新建孤儿 worktree（无 parent，独立历史，不触碰当前工作分支）。
  //    ⚠️ `--orphan` 必须用 `-b <branch>` 指定分支名，不能传 commit-ish
  //    （`git worktree add --orphan <path> cache` 会把 cache 当 commit-ish 报错）
  git(["worktree", "add", "--orphan", "-b", BRANCH, WT_PATH])

  // ③ 复制数据到 worktree（孤儿 worktree 初始为空 → cache 分支根目录只含这些 json，
  //    不带任何代码文件；缺文件则跳过，不中断）
  let copied = 0
  for (const f of FILES) {
    const src = path.join(OUT_DIR, f)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(WT_PATH, f))
      copied++
    }
  }
  if (copied === 0) {
    console.warn("scripts/output 下无缓存文件，发布空 commit")
  }

  // ④ 洁癖单 commit（--allow-empty 避免「nothing to commit」中断流程）
  //    兜底配置 git 身份：本地或 runner 未设置 user.name/user.email 时，
  //    commit 会报 "Please tell me who you are" 而失败，这里统一用缓存 bot。
  if (!tryGit(["config", "user.name"])?.trim()) {
    git(["config", "user.name", "deepsea-cache-bot"])
  }
  if (!tryGit(["config", "user.email"])?.trim()) {
    git(["config", "user.email", "cache-bot@deepsea.local"])
  }
  git(["add", "-A"], WT_PATH)
  git(
    ["commit", "-m", `cached at ${new Date().toISOString()}`, "--allow-empty"],
    WT_PATH
  )

  // ⑤ 覆盖推送：远端 cache 恒为单 commit
  git(["push", "origin", BRANCH, "--force"])

  // ⑥ 清理 worktree（分支保留在远端，无需本地残留）
  tryGit(["worktree", "remove", "--force", WT_PATH])
  tryGit(["branch", "-D", BRANCH])

  console.log(`✅ 已发布 ${copied} 个文件到 cache 分支（force push，单 commit）`)
}

main()
