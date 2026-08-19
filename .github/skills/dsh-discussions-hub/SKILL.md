---
name: dsh-discussions-hub
description: '包装官方 GitHub Discussions 为更好的社区体验。Use when: 读取/展示 deepseek-harness 官方 discussions、按分类分区、讨论列表与详情、GraphQL 查询、讨论热度排序、评论展示、发帖跳转。'
argument-hint: '要展示的讨论主题或分类，例如 "插件推荐" 或留空展示全部'
user-invocable: true
---

# Discussions 包装层

## 目标

通过 GitHub GraphQL API 包装 `deepseek-ai/deepseek-harness` 的官方 discussions，提供比官方页面更好的分区、访问速度与视觉感受。

## 何时使用

- 实现「社区 / Discussions」页面
- 需要按分类（category）分区展示讨论
- 需要讨论列表、详情、评论、热度排序
- 需要引导用户到官方发起新讨论

## 关键事实

- 目标仓库：`deepseek-ai/deepseek-harness`（`has_discussions: true`）
- Discussions **只能通过 GraphQL** 访问（REST 无此接口）- **GraphQL 必须带 token 认证**（匿名浏览器请求返回 403）——因此采用
  「Actions 同步 seed」架构（与插件种子一致）：
  - 同步脚本 `scripts/sync-discussions.mjs`（`pnpm sync:discussions`）用
    `GITHUB_TOKEN` 抓取前 50 条 → 生成
    `apps/web/public/data/discussions.json` 静态 JSON
  - 前端 `lib/github/discussions.ts` 的 `loadDiscussionsSeed()` fetch 静态
    JSON（内存缓存、零 API 配额、无需登录）；热门（评论数）/最新
    （updatedAt）排序在本地完成
  - 每小时由 `.github/workflows/sync-plugin-seed.yml` 同步并提交
## 步骤

### 1. 查询分类列表

```graphql
query ($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    discussionCategories(first: 20) {
      nodes { name id }
    }
  }
}
```

### 2. 查询讨论列表（按分类过滤 + 分页）

```graphql
query ($owner: String!, $repo: String!, $category: ID, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    discussions(
      first: $first
      after: $cursor
      categoryId: $category
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
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
```

### 3. 查询讨论详情与评论

```graphql
query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      title body category { name } url
      comments(first: 50) {
        nodes { body author { login } createdAt }
      }
    }
  }
}
```

### 4. 分区与展示

- 侧边栏按 `category.name` 分组（如 Announcements、General、Ideas、Q&A）
- 列表项展示：标题、分类徽章、评论数、更新时间、作者
- 提供排序：最新、最热（评论数）、未回复
- **配色自适应（autoColor）**：社区页设置背景图（dsh→`/c1.png` 蓝鲸、dpc→`/c2.png` 浪尖）
  后，`lib/theme/auto-color.ts` 分析背景图色调推选三色（primary/secondary/accent），
  注入 CSS 变量 `--theme-*`，驱动卡片点阵渐变、身份徽章、分类激活、hover 边框、评论徽章。
  - 算法：HSV 量化 16 色桶 + `权重 = S × (1 - |V-0.5|×2)` 偏向彩色 + 色相分散选举。
  - 组件可手动配置三色兜底（`COMMUNITY_THEME`）；分类徽章/色条保留 6 色分类语义不变。

### 5. 交互与跳转

- 详情页可内嵌渲染（markdown 渲染 body 与评论），或引导跳转官方 URL
- 「发起讨论」按钮跳转官方：`https://github.com/deepseek-ai/deepseek-harness/discussions/new`

### 6. 缓存与性能

- 讨论列表做 1–5 分钟缓存；详情按需加载
- 分页用 cursor（`endCursor`），避免深分页限流

## 完成标准

- [ ] 分类分区展示可用
- [ ] 列表 + 详情 + 评论完整
- [ ] 有排序、分页、缓存
- [ ] 可一键跳转/发起官方讨论
