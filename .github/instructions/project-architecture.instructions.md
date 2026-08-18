---
description: "Use when 开发 deepSea 项目：新增页面与路由、目录结构、技术栈选型、monorepo 包管理、模块拆分。covers Vite React shadcn octokit animejs 无后端架构规范。"
name: "deepSea 项目架构规范"
applyTo: ["apps/web/src/**", "packages/**"]
---

# deepSea 项目架构规范

## 项目定位

deepSea 是 DeepSeek Harness（dsh）插件生态聚合站：

- 搜罗与聚类 `deepseek-harness` 相关插件的生态（官方库：`deepseek-ai/deepseek-harness`）
- 提供周边插件的快速搜索、下载与使用
- 提供公共社区、插件评分等能力的对接

## 技术栈（固定，不可随意更换）

| 领域 | 选型 |
| ---- | ---- |
| 框架 | Vite + React 19 + TypeScript（严格模式） |
| UI | shadcn/ui（Radix + Tailwind CSS v4） |
| 动效 | animejs（仅用于展示 / 落地页） |
| 数据 | 无后端，全部通过 octokit 直连 GitHub API（REST + GraphQL） |
| 鉴权 | Cloudflare Worker 仅做 OAuth（登录/回调/会话），不承载任何数据 API |
| 包管理 | pnpm workspace monorepo |

## 硬性规则

1. **禁止修改 `src/components/ui/**`** —— 该目录由 shadcn CLI 管理。新增 UI 组件必须用
   `pnpm --filter @deepsea/web dlx shadcn add <name>`，不要手写或覆盖其中的文件。
2. **禁止引入后端** —— 不建 server、不存数据库、不引入 SSR；一切数据来自 GitHub API。
3. **【Worker 红线】`apps/worker` 只做 OAuth auth**（`/auth/login` `/auth/callback` `/auth/me` `/auth/logout`），
   不承载任何业务数据代理。所有 GitHub 数据读写（搜索 / discussions 列表详情回复表情发帖 / issues / releases）
   一律由前端 `lib/github/` 用 octokit 直调；前端 access token 由 `/auth/me` 返回（内存保存）。
   新增功能时**禁止给 Worker 加 `/api/*` 代理路由**——能前端化的一定前端化。
4. **路径别名 `@/*` 指向 `apps/web/src/*`**（见 `apps/web/tsconfig.app.json` 与 `vite.config.ts`）。
5. animejs 只允许用于展示/落地页的动效，业务 UI 保持克制，避免影响可读性与性能。
6. 新增共享代码（GitHub 客户端、类型、hooks）应放入 `packages/*`，通过 workspace 依赖引用。

## 目录结构约定

```
apps/web/src/
├── pages/          # 路由页面（每个功能一个页面组件）
├── components/     # 业务组件（按功能分子目录）
│   └── ui/         # shadcn 生成组件（CLI 管理，禁止手改）
├── lib/
│   ├── github/     # octokit 封装（client、search、discussions、issues）
│   └── utils.ts    # cn() 等工具
├── hooks/          # 自定义 hooks（数据获取、缓存、鉴权）
├── stores/         # 全局状态（如插件收藏、已安装列表）
└── types/          # 领域类型（Plugin、Discussion、Issue 等）
```

## 核心页面与功能

1. **插件生态搜索**：对全 GitHub 相关插件 topics/关键词搜索，汇聚周边生态插件动态。
2. **Discussions 包装**：通过官方 API 包装官方 discussions，提供更好的分区、访问速度与视觉感受。
3. **安装与互助**：统一界面直连对应插件的 issues，发起提问与工单。
4. **插件管理与更新**：插件管理与更新提示；`deepc` 插件可复刻本站在本地使用。
5. **安全管理**：dsh 插件 `deepc` 的映射方案、动态安全路径、二次验证。

## Monorepo 约定

- 工作区：`apps/*`、`packages/*`（见 `pnpm-workspace.yaml`）
- 根目录只放共享配置与脚本；业务依赖声明在各包 `package.json` 中
- 新增包时同步补充根 `tsconfig.json` 的 `references`
