# deepSea · DeepSeek Harness 插件生态聚合站

> 搜罗与聚类 `deepseek-harness` 周边插件生态，提供快速搜索、下载使用、公共社区、插件评分等能力的对接。

- 官方库：<https://github.com/deepseek-ai/deepseek-harness>（"Everything is a Plugin"）
- 生态 topics：`dsh` · `dsh-plugin` · `dsh-plugins` · `dsh-patch` · `cordis` · `plugin-marketplace` 等

## 技术栈

| 领域   | 选型                                                       |
| ------ | ---------------------------------------------------------- |
| 框架   | Vite + React 19 + TypeScript                               |
| UI     | shadcn/ui（Radix + Tailwind CSS v4）                       |
| 动效   | animejs（仅用于展示 / 落地页）                             |
| 数据   | 无后端，全部通过 octokit 直连 GitHub API（REST + GraphQL） |
| 包管理 | pnpm workspace monorepo                                    |

## 结构

```
deepSea/
├── apps/
│   └── web/          # 主站点（Vite + React + shadcn/ui）
├── packages/         # 预留：共享包（github 客户端、类型、hooks 等）
├── .github/
│   ├── instructions/ # 项目级 Copilot 指令（架构 / GitHub API / UI 规范）
│   └── skills/       # dsh 生态工作流技能
├── pnpm-workspace.yaml
└── package.json
```

## 核心功能

1. **插件生态搜索** — 对全 GitHub 的相关插件 topics/关键词搜索，汇聚所有周边生态插件动态。
2. **Discussions 包装** — 通过官方 API 包装官方 discussions，提供更好的分区、访问速度与视觉感受。
3. **安装与互助** — 统一界面提供高效的插件安装体验，直连对应插件的 issues 发起提问与工单。
4. **插件管理与更新** — 快速的插件管理与更新提示；`deepc` 插件可复刻本站点完全用于本地使用。
5. **安全管理** — 构造 dsh 插件 `deepc` 用于 deepseek-harness 安全管理：统一且安全的映射方案、动态安全路径、二次验证。

## 开发

```bash
pnpm install          # 安装依赖（pnpm workspace）
pnpm dev              # 启动 apps/web 开发服务器
pnpm build            # 全量构建
pnpm typecheck        # 全量类型检查
pnpm lint             # oxlint 代码检查
pnpm format           # oxfmt 格式化
pnpm format:check     # oxfmt 格式校验（CI 用）
```

> 注意：`src/components/ui/**` 由 shadcn CLI 管理，请勿手改。新增组件使用 `pnpm --filter @deepsea/web dlx shadcn add <name>`。

