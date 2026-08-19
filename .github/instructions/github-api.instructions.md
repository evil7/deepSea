---
description: "Use when 调用 GitHub API、octokit、搜索插件仓库、读取 discussions、创建 issue、GraphQL/REST 查询、鉴权与限流处理。covers octokit 使用规范。"
name: "GitHub API (octokit) 使用规范"
applyTo: ["apps/web/src/lib/github/**", "apps/web/src/hooks/**", "packages/**"]
---

# GitHub API（octokit）使用规范

## 核心原则

- 全部通过 `@octokit/rest`（REST）与 `@octokit/graphql`（GraphQL）访问 GitHub，禁止裸 `fetch` 手拼 URL。
- **discussions 只有 GraphQL 可用**；仓库/插件搜索、issues、releases 用 REST。
- 统一封装在 `apps/web/src/lib/github/` 下，组件与页面**不得直接 import octokit**，必须走封装后的函数与 hooks。
- Token 只存在于前端内存/会话中，禁止写入仓库、localStorage 明文存储；未登录时以匿名身份访问（限流更低，需做好降级提示）。
- **【架构红线】一切可直接前端化的 GitHub 能力都用前端 octokit 直调官方 API，不得扩展后端（Cloudflare Worker）代理**。
  后端 Worker **只做 auth**（OAuth 登录 / 回调 / 会话校验 / 登出），并把 access token 通过 `/auth/me` 返回给前端
  （前端 `setGitHubToken()` 存内存）。所有数据读写——包括 discussions 列表、详情、回复、表情反应、
  创建讨论、issues、releases——一律在前端 `lib/github/` 用 octokit 完成。
  新增能力时先问：能前端化吗？能就直接加前端 octokit 封装，不要再给 Worker 加 `/api/*` 代理路由。

## 客户端初始化（`lib/github/client.ts`）

```ts
import { Octokit } from "@octokit/rest"
import { graphql } from "@octokit/graphql"

let token: string | null = null // 登录后 setGitHubToken() 注入；只存内存

// ⚠️⚠️ authStrategy 返回的对象必须同时含 `auth` 和 `hook` 两个方法：
//   octokit core 会执行 `hook.wrap("request", auth.hook)`，缺 hook 会在发请求前
//   抛 "Cannot read properties of undefined (reading 'bind')"，导致所有 REST 调用静默失败。
export const octokit = new Octokit({
  authStrategy: () => ({
    async auth() {
      const t = token
      return t
        ? { type: "token" as const, token: t, tokenType: "oauth" }
        : { type: "unauthenticated" }
    },
    // hook 签名复刻 @octokit/auth-token 的 hook(token, request, route, parameters)
    async hook(request, route, parameters) {
      const t = token
      const endpoint = request.endpoint.merge(route, parameters)
      if (t) endpoint.headers.authorization = `Bearer ${t}`
      return request(endpoint)
    },
  }),
})
```

- `auth` 字段不接受函数（`auth: () => token` 会抛 "Token passed to createTokenAuth is not a string"）；
  动态 token 用自定义 `authStrategy`（返回 `{ auth, hook }`），登录后无需重建单例。
- GraphQL 用 `githubGraphQL()`（每次请求动态读 token + headers），不走 octokit 实例。

## 插件搜索（`lib/github/search.ts`）

- 官方库 topics：`dsh`、`dsh-plugin`、`cordis`、`ai-agents`
- 生态关键词集合（集中维护于 `lib/github/topics.ts`）：

```ts
export const PLUGIN_TOPICS = [
  "dsh", "dsh-plugin", "dsh-plugins", "dsh-patch", "dsh-skill",
  "deepseek-harness", "deepseek-harness-plugin", "cordis-plugin",
  "plugin-marketplace", "plugin-store",
]
```

- 搜索示例：`octokit.search.repos({ q: "topic:dsh-plugin stars:>10", sort: "updated", per_page: 50 })`
- 结果需**去重**（同一插件可能命中多个 topic）并**聚合**（star、更新时间、话题标签）。
- 分页使用 `octokit.paginate`；对结果做本地缓存（见下）。

## Discussions（`lib/github/discussions.ts`）

```graphql
query ($owner: String!, $repo: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    discussions(first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title category { name } url comments { totalCount } }
    }
  }
}
```

- 主社区 = `evil7/deepSea`（自有仓库，可互动，站内回复/表情/发帖）；
  官方 `deepseek-ai/deepseek-harness` 仅作只读跳转链接。
- 列表/详情/回复/表情/创建讨论全部走**前端 octokit GraphQL 直调**（登录后带 token），
  不经过 Worker 代理。相关 mutation：`createDiscussion`、`addDiscussionComment`、
  `addReaction`、`removeReaction`。
- 匿名用户读静态 seed（`public/data/discussions.json`，Actions 每小时同步）零配额；
  登录后前端定时（3 分钟）octokit 直调最新列表替换内存缓存。

## Issues / 工单（`lib/github/issues.ts`）

- 跳转：插件详情页提供「提问 / 发工单」按钮，直连该插件仓库的 `issues/new`（带预填标题模板）。
- 创建：`octokit.issues.create({ owner, repo, title, body, labels })`，需要用户已登录授权。
- 读取某个插件的 issue 列表：`octokit.issues.listForRepo({ owner, repo, state: "open" })`。

## 缓存与限流

- 所有读接口用 SWR / TanStack Query 等做缓存与去重，减少 API 调用。
- 捕获 `rate limit`（`x-ratelimit-remaining`）与 403/429 错误，统一提示并建议登录。
- 搜索等低频变化数据可做 5–10 分钟级本地缓存（sessionStorage 或内存）。
