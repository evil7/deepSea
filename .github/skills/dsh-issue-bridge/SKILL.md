---
name: dsh-issue-bridge
description: '插件安装引导与统一工单入口。Use when: 生成插件安装命令、一键安装引导、跳转对应仓库 issues 提问/发工单、预填 issue 模板、读取插件 issue 列表、安装状态与更新提示。'
argument-hint: '要安装或提问的插件，例如 "deepseek-harness-desktop" 或 "anywhere-labs/deepseek-harness-desktop"'
user-invocable: true
---

# 插件安装与工单对接

## 目标

在统一界面提供「高效快速的插件安装与互助体验」：对每个插件生成安装指引，并直连该插件仓库的 issues 发起提问与工单。

## 何时使用

- 插件详情页 / 列表页展示「安装」按钮
- 用户需要对某插件提问、反馈 Bug、请求功能
- 需要展示某插件的 open issues 列表与状态
- 需要插件更新提示

## 关键事实

- 官方库 `deepseek-ai/deepseek-harness` **未开启 issues**，但其生态插件仓库大多开启（如 `anywhere-labs/deepseek-harness-desktop`、`dataelement/dsh-desktop` 等，`has_issues: true`）
- 安装命令按插件仓库 README 约定生成，常见形式：

```bash
dsh plugin install <owner>/<repo>        # 从 GitHub 安装
dsh plugin add <plugin-name>             # 从插件市场/registry 安装
```

- 生态插件市场参考：`imsai-sh/awesome-deepseek-harness-plugins`（3100+ 插件，含安装命令与搜索 API）

## 步骤

### 1. 生成安装指引

- 读取插件仓库 README（`octokit.repos.getReadme` 或 contents API）提取安装命令
- 无法解析时给出通用模板（`dsh plugin install <owner>/<repo>`）并提供官方文档链接

### 2. 一键安装体验（本地/桌面端）

- Web 站提供「复制安装命令」与「在 deepc 中安装」入口
- 若在 deepc 本地环境（见 `dsh-security-audit`），直接调用本地 dsh CLI 执行安装

### 3. 提问 / 工单直连

- 插件详情页提供「提问」按钮 → 跳转 `https://github.com/<owner>/<repo>/issues/new`，预填：

```
## 环境
- dsh 版本：
- 插件版本：
- 平台：

## 问题描述
（请描述你遇到的问题）

## 复现步骤
1.
2.

## 期望行为

## 实际行为
```

- 已登录用户可直接通过 `octokit.issues.create` 创建（需确认该仓库 `has_issues`）
- 未登录用户跳转 GitHub 登录后预填

### 4. Issue 列表与状态

- `octokit.issues.listForRepo({ owner, repo, state: "open", sort: "updated" })`
- 展示：标题、labels、评论数、更新时间；支持按 label 筛选（bug / feature / help wanted）

### 5. 更新提示

- 通过 Releases API 对比插件当前版本与最新 release（`octokit.repos.listReleases` 取第一条 tag_name）
- 订阅过的插件列表本地存储，有新版时在「插件管理」页提示更新

## 完成标准

- [ ] 每个插件可复制/执行安装命令
- [ ] 提问按钮直连对应仓库 issues 并预填模板
- [ ] 展示该插件 open issues（含标签筛选）
- [ ] 更新提示可用（release 对比）
