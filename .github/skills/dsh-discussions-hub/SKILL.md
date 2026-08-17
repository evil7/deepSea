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
- Discussions **只能通过 GraphQL** 访问（REST 无此接口）

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
