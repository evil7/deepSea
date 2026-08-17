---
name: dsh-plugin-discovery
description: '在 GitHub 上搜索与聚合 DeepSeek Harness (dsh) 插件生态。Use when: 需要发现 dsh 插件、搜索插件仓库、聚合生态动态、插件排行榜、按 topic/关键词筛选、抓取插件元数据。'
argument-hint: '要发现/搜索的插件方向或关键词，例如 "代码生成插件" 或 "topic:dsh-plugin"'
user-invocable: true
---

# dsh 插件生态发现与聚合

## 目标

在 GitHub 上按官方与社区 topic/关键词搜索所有 `deepseek-harness` 相关插件，汇聚生态动态，输出结构化的插件列表。

## 何时使用

- 需要发现新的 dsh 插件
- 需要按 topic、star、更新时间排序展示插件
- 需要聚合多个搜索源（官方库、awesome 列表、插件市场）的结果
- 需要为「插件生态」页面提供数据源

## 关键事实（官方库）

- 官方库：`deepseek-ai/deepseek-harness`（"Everything is a Plugin"）
- 官方 topics：`dsh`、`dsh-plugin`、`cordis`、`ai-agents`
- 官方库未开启 issues（`has_issues: false`），但**开启了 discussions**（`has_discussions: true`）
- 生态常用 topics：`dsh`、`dsh-plugin`、`dsh-plugins`、`dsh-patch`、`dsh-skill`、`deepseek-harness`、`deepseek-harness-plugin`、`cordis-plugin`、`plugin-marketplace`、`plugin-store`

## 步骤

### 1. 构造搜索关键词

集中维护关键词集合（建议 `src/lib/github/topics.ts`），搜索时对每个 topic 查询：

```ts
const queries = PLUGIN_TOPICS.map((t) => `topic:${t}`)
```

可选附加条件：`stars:>5`、`pushed:>2025-01-01`、`language:typescript` 等。

### 2. 执行搜索（REST Search API）

```ts
import { octokit } from "@/lib/github/client"

const res = await octokit.paginate(octokit.search.repos, {
  q: `topic:dsh-plugin stars:>10`,
  sort: "updated",
  per_page: 100,
})
```

### 3. 去重与聚合

- 同一仓库会命中多个 topic → 按 `full_name` 去重
- 聚合字段：`full_name`、`description`、`stargazers_count`、`pushed_at`、`topics`、`html_url`
- 剔除官方库本身与 awesome/curated 类列表仓库（或单独分类展示）

### 4. 排序与展示

- 提供排序维度：star 数、最近更新时间、forks、创建时间
- 提供筛选维度：language、topic、是否为官方/社区
- 附带元数据：README 简介截断、仓库语言、license

### 5. 缓存

- 搜索结果是低频变化数据：做 5–10 分钟内存/sessionStorage 缓存
- 命中限流（403/429）时降级显示缓存并提示登录

## 完成标准

- [ ] 输出去重后的插件列表（含完整元数据）
- [ ] 支持按 topic 与关键词快速筛选
- [ ] 有缓存与限流降级处理
- [ ] 每个插件可跳转到详情页（用于安装/提问，见 `dsh-issue-bridge`）
