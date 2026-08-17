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

## 客户端初始化（`lib/github/client.ts`）

```ts
import { Octokit } from "@octokit/rest"
import { graphql } from "@octokit/graphql"

// 匿名或用户 Token（登录后注入）
export const octokit = new Octokit({ auth: getToken() ?? undefined })
export const gql = graphql.defaults({ headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {} })
```

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

- 官方 discussions 地址：`deepseek-ai/deepseek-harness`（该仓库 `has_discussions: true`）
- 按 `category.name` 分区展示；评论数、更新时间用于排序与热度展示。

## Issues / 工单（`lib/github/issues.ts`）

- 跳转：插件详情页提供「提问 / 发工单」按钮，直连该插件仓库的 `issues/new`（带预填标题模板）。
- 创建：`octokit.issues.create({ owner, repo, title, body, labels })`，需要用户已登录授权。
- 读取某个插件的 issue 列表：`octokit.issues.listForRepo({ owner, repo, state: "open" })`。

## 缓存与限流

- 所有读接口用 SWR / TanStack Query 等做缓存与去重，减少 API 调用。
- 捕获 `rate limit`（`x-ratelimit-remaining`）与 403/429 错误，统一提示并建议登录。
- 搜索等低频变化数据可做 5–10 分钟级本地缓存（sessionStorage 或内存）。
