---
description: "Use when 开发 deepSea 项目：新增页面与路由、目录结构、技术栈选型、monorepo 包管理、模块拆分。covers Vite React shadcn octokit animejs Cloudflare Worker 前后端分层架构规范。"
name: "deepSea 项目架构规范"
applyTo: ["apps/web/src/**", "packages/**", "apps/worker/src/**"]
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
| GitHub 数据 | 前端 octokit 直连 GitHub API（REST + GraphQL），无代理 |
| 鉴权/互联 | Cloudflare Worker = **auth 最小边界**（OAuth + 设备授权 + 设备注册 + 信令 DO + 账号配置 + 审计） |
| 包管理 | pnpm workspace monorepo |

## 硬性规则

1. **禁止修改 `src/components/ui/**`** —— 该目录由 shadcn CLI 管理。新增 UI 组件必须用
   `pnpm --filter @deepsea/web dlx shadcn add <name>`，不要手写或覆盖其中的文件。
2. **禁止引入「业务后端」** —— 主站 GitHub 数据不建 server、不存数据库、不引入 SSR；
   一切 GitHub 数据来自前端 octokit 直调 GitHub API。（例外：`apps/worker` 是 CF Worker，
   承载「auth 最小边界」，见下条。）
3. **【Worker 红线】`apps/worker` 只做「auth 最小边界」**，两条铁律：
   - **能前端化的 GitHub 数据一律前端 octokit 直调**（搜索 / discussions 列表详情回复表情发帖 /
     issues / releases），前端 access token 由 `/auth/me` 返回（内存保存）。
     **禁止给 Worker 加 `/api/*` 代理路由**。
   - **deepc-link 互联数据**（`/auth/node/*` 设备注册、`/auth/device-grant*` 设备授权、
     `/ws/signal` 信令 DO、`/auth/config/*` 账号配置、审计日志）属于 auth 边界，允许；
     但**数据面（会话消息 / 工作区内容 / 配置详情）一律走 P2P DataChannel，绝不进 Worker**。
   - 详细红线与前后端分层见 `deepc-link.instructions.md`。
4. **路径别名 `@/*` 指向 `apps/web/src/*`**（见 `apps/web/tsconfig.app.json` 与 `vite.config.ts`）。
5. animejs 只允许用于展示/落地页的动效，业务 UI 保持克制，避免影响可读性与性能。
6. 新增共享代码（GitHub 客户端、类型、hooks）应放入 `packages/*`，通过 workspace 依赖引用。

## 目录结构约定

```
apps/web/src/
├── pages/          # 路由页面（每个功能一个页面组件）
├── components/     # 业务组件（按功能分子目录）
│   ├── ui/         # shadcn 生成组件（CLI 管理，禁止手改）
│   ├── layout/     # 跨页面布局组件（Topbar、PageHeader 共享页头）
│   ├── link/      # 操作互联 chatUI（消息流 / composer / FolderPicker）
│   └── showcase/   # 展示/落地页动效（Ocean、插件码牌、usePageEnter/useSlideReveal 过渡 hook）
├── lib/
│   ├── github/     # octokit 封装（client、search、discussions、issues）
│   ├── deepc-link/ # 主站 RTC client（DeepcClient / WS 信令 / nodes / fold）
│   ├── theme/      # 配色自适应（auto-color 背景图取色纯函数）
│   └── utils.ts    # cn() 等工具
├── hooks/          # 自定义 hooks（数据获取、缓存、鉴权、use-auto-color 取色）
├── stores/         # 全局状态（如插件收藏、已安装列表）
└── types/          # 领域类型（Plugin、Discussion、Issue 等）
```

补充约定：

- **共享页头**用 `components/layout/page-header.tsx`（`PageHeader`），子页面统一，勿手写页头。
- **场景过渡**用 `components/showcase/` 下的 `usePageEnter`（挂载）/ `useSlideReveal`（视口）。
- **背景图自动取色**（社区页 autoColor）用 `lib/theme/auto-color.ts` 纯函数 + `hooks/use-auto-color.ts`。
- 组件内配色走 CSS 变量 `--theme-*` 或 `custom.css` 语义类，禁硬编码 cyan/amber（见 ui-guidelines）。

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
