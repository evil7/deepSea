# deepSea · DeepSeek Harness 插件生态聚合站

> DeepSeek Harness 插件生态的入海口——发现、安装、管理、互联，一站式聚合。

- 官方库：<https://github.com/deepseek-ai/deepseek-harness>（"Everything is a Plugin"）
- 生态 topics：`dsh` · `dsh-plugin` · `dsh-plugins` · `dsh-patch` · `cordis` · `plugin-marketplace` 等

## 技术栈

| 领域   | 选型                                                       |
| ------ | ---------------------------------------------------------- |
| 框架   | Vite + React 19 + TypeScript                               |
| UI     | shadcn/ui（Radix + Tailwind CSS v4）                       |
| 动效   | animejs（仅用于展示 / 落地页）                             |
| GitHub 数据 | 前端 octokit 直连 GitHub API（REST + GraphQL）        |
| 鉴权/互联 | Cloudflare Worker = auth 最小边界（OAuth + 设备授权 + 信令 DO + 配置 + 审计） |
| 包管理 | pnpm workspace monorepo                                    |

## 结构

```
deepSea/
├── apps/
│   ├── web/          # 主站点（Vite + React + shadcn/ui + 操作互联 chatUI）
│   └── worker/       # Cloudflare Worker（auth 最小边界：OAuth + 设备授权 + 信令 DO + 配置 + 审计 + ASSETS）
├── packages/
│   └── deepc-bridge/ # 深海套装互联插件（前后端分层 + RTC 数据面 + WS 信令）
├── .github/
│   ├── instructions/ # 项目级 Copilot 指令（架构 / GitHub API / UI / deepc-bridge 互联规范）
│   └── skills/       # dsh 生态 + 互联工作流技能
├── docs/             # 设计文档（deepsea-deepc-bridge-* 互联方案 + oauth-worker 等）
├── pnpm-workspace.yaml
└── package.json
```

## 部署（Cloudflare Workers）

静态内容直接作为 Worker 的 ASSETS 发布（OAuth 逻辑与静态资源一体）：

```bash
pnpm build               # 构建前端（apps/web/dist）+ Worker 检查
pnpm deploy              # 先 typegen 生成类型 → build 构建 → 发布 Worker（含 ASSETS + OAuth）
```

**Secret 管理**（wrangler secret，交互式输入值）：

```bash
pnpm secret:list                          # 列出已配置的 secret
pnpm secret:put -- GITHUB_CLIENT_ID       # 新增/更新（回车后输入值）
pnpm secret:del -- GITHUB_CLIENT_SECRET   # 删除
```

**类型生成**（由 `wrangler.toml` 生成 Worker 环境类型）：

```bash
pnpm typegen                              # 生成 apps/worker/worker-configuration.d.ts
```

- 修改 `apps/worker/wrangler.toml`（bindings / vars / routes）后需重新 `pnpm typegen`。

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
2. **插件精选** — 热门/最新精选画廊，封面流呈现生态亮点，直达插件详情。
3. **Discussions 包装** — 蓝鲸酒馆双社区：官方只读直连 + 自家可互动，更好的分区与视觉体验。
4. **安装与互助** — 统一生成安装指引，直连对应插件 issues 发起提问与工单。
5. **集中管理与更新** — `deepc` 本地集中管理多 profile 插件：清单、版本、更新提示一站式。
6. **深海套装（deepc）** — 主题快速构造 + 多端互联（WebRTC）+ 安全护栏，规划见 `docs/deepsea-suite-*.md`。

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

