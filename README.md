# deepSea · DeepSeek Harness 插件生态聚合站

> 搜罗类聚 deepseek-harness 周边插件生态，提供快速搜索、下载使用、社区讨论、插件评分、协助开发等能力。

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
│   ├── web/          # 主站点（Vite + React + shadcn/ui）
│   └── worker/       # Cloudflare Worker（GitHub OAuth 登录 + 静态资源 ASSETS 托管）
├── packages/         # 预留：共享包（github 客户端、类型、hooks 等）
├── .github/
│   ├── instructions/ # 项目级 Copilot 指令（架构 / GitHub API / UI 规范）
│   └── skills/       # dsh 生态工作流技能
├── docs/             # 设计构思文档（deepsea-oauth-worker 等）
├── pnpm-workspace.yaml
└── package.json
```

## 部署（Cloudflare Workers）

静态内容直接作为 Worker 的 ASSETS 发布（OAuth 逻辑与静态资源一体）：

```bash
pnpm build               # 构建前端（apps/web/dist）+ Worker 检查
pnpm deploy              # 先 build，再发布 Worker（含 ASSETS + OAuth）
```

**Secret 管理**（wrangler secret，交互式输入值）：

```bash
pnpm secret:list                          # 列出已配置的 secret
pnpm secret:put -- GITHUB_CLIENT_ID       # 新增/更新（回车后输入值）
pnpm secret:del -- GITHUB_CLIENT_SECRET   # 删除
```

- 部署前需：`wrangler kv namespace create DEEPSEA_KV`（id 填入 wrangler.toml）、
  `pnpm secret:put -- GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / TOKEN_ENC_KEY`
- 本地联调：`pnpm dev:all`（`scripts/dev.mjs` 同时启动 worker 8787 + 前端 5174；
  vite 将 `/auth/*` 代理到 worker，OAuth 本地闭环）
  - 单起前端：`pnpm dev`（需 worker 已在 8787 运行，否则 /auth 代理 502）
  - 单起 worker：`pnpm dev:worker`
- 本地 OAuth：`apps/web/.env`（`VITE_GITHUB_OAUTH_CLIENT_ID` + `VITE_DEEPSEA_BASE=http://127.0.0.1:5174`）+ `apps/worker/.dev.vars`
- 详见 `docs/deepsea-oauth-worker.md`

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

