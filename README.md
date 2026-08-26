# deepSea

> DeepSeek Harness (DSH) 插件生态聚合站——发现、安装、管理、互联，一站式入口。

**[deepc.cn](https://deepc.cn)** 聚合全 GitHub 的 DSH 插件生态，提供搜索、精选、安装指引、
社区讨论，以及 **deepc-link** 多端互联能力（WebRTC 加密通道远程控制本地 DSH host）。

- 官方库：<https://github.com/deepseek-ai/deepseek-harness>（"Everything is a Plugin"）
- 互联插件：<https://www.npmjs.com/package/deepc-link>

## 核心功能

| 功能 | 说明 |
|------|------|
| **插件生态搜索** | 全 GitHub 按 topics / 关键词搜索，汇聚 `dsh` · `dsh-plugin` · `cordis` 等周边生态 |
| **插件精选** | 热门 / 最新精选画廊，封面流呈现生态亮点，直达插件详情 |
| **Discussions 社区** | 蓝鲸酒馆双社区：官方只读直连 + 自家可互动，分区清晰 |
| **安装与互助** | 统一生成 `dsh plugin add` 安装指引，直连插件 issues 发起提问 |
| **多端互联** | deepc-link 插件经 WebRTC 加密通道远程控制本地 DSH host |

## 技术栈

| 领域 | 选型 |
|------|------|
| 前端 | Vite + React 19 + TypeScript + shadcn/ui (Radix + Tailwind CSS v4) |
| 动效 | animejs（展示 / 落地页） |
| 数据 | octokit 直连 GitHub API（REST + GraphQL） |
| 后端 | Cloudflare Worker（OAuth + 设备授权 + 信令 DO + 配置同步 + 审计） |
| 互联 | deepc-link（node-datachannel WebRTC + WS 信令 + 加密 RTC 数据面） |
| 包管理 | pnpm workspace monorepo |

## 项目结构

```
deepSea/
├── apps/
│   ├── web/          # 主站点（Vite + React + shadcn/ui）
│   └── worker/       # Cloudflare Worker（auth 最小边界 + ASSETS）
├── packages/
│   └── deepc-link/   # 多端互联插件（node + browser 双端，npm 已发布）
├── scripts/          # 生态数据采集脚本（GitHub 搜索 / Discussions 同步）
├── docs/             # 设计文档（互联方案 / OAuth / 配置同步等）
└── .github/          # Copilot 指令 + skills
```

## 快速开始

### 环境要求

- Node.js ≥ 20.19.0
- pnpm ≥ 11（通过 corepack 或全局安装）

### 本地开发

```bash
pnpm install          # 安装依赖
pnpm dev:all          # 同时启动 worker (8787) + web (5174)
```

> `pnpm dev` 单起前端（需 worker 已运行），`pnpm dev:worker` 单起 worker。
> vite 会将 `/auth/*` 代理到 worker，OAuth 本地闭环。

### 本地 OAuth 配置

- `apps/web/.env`：`VITE_GITHUB_OAUTH_CLIENT_ID` + `VITE_DEEPSEA_BASE=http://127.0.0.1:5174`
- `apps/worker/.dev.vars`：`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `TOKEN_ENC_KEY`

## 构建与部署

```bash
pnpm build            # 全量构建（web + worker）
pnpm typecheck        # 全量类型检查
pnpm deploy           # typegen → build → 发布 Worker 到 Cloudflare
```

**Secret 管理**（wrangler secret，交互式输入）：

```bash
pnpm secret:list                            # 列出已配置的 secret
pnpm secret:put -- GITHUB_CLIENT_ID         # 新增/更新
pnpm secret:del -- GITHUB_CLIENT_SECRET     # 删除
```

**前置条件**：

1. `wrangler kv namespace create DEEPSEA_KV`（id 填入 `wrangler.toml`）
2. `pnpm secret:put -- GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / TOKEN_ENC_KEY`
3. 修改 `apps/worker/wrangler.toml` 后需 `pnpm typegen`

详见 [`docs/deepsea-oauth-worker.md`](docs/deepsea-oauth-worker.md)。

## deepc-link 互联插件

deepc-link 是 DSH 的多端互联插件，经 WebRTC 加密通道实现远程控制本地 DSH host。

**一键安装**：

```bash
dsh plugin --profile web add deepc-link@latest
```

**本地联调**：

```bash
pnpm plugin:pack      # 构建 + 打 tgz
dsh plugin --profile web add ./packages/deepc-link/deepc-link-0.0.1.tgz
# 安装后在插件 Sheet 打开「开发模式」→ 自动连本地 http://127.0.0.1:5174
```

详见 [`packages/deepc-link/README.md`](packages/deepc-link/README.md)。

## 开发命令

```bash
pnpm dev              # 启动 web 开发服务器
pnpm dev:all          # 同时启动 worker + web
pnpm build            # 全量构建
pnpm typecheck        # 类型检查
pnpm lint             # oxlint 代码检查
pnpm format           # oxfmt 格式化
pnpm plugin:build     # 构建 deepc-link 插件
pnpm plugin:release   # 发布 deepc-link 到 npm（需 NPM_TOKEN）
```

> UI 组件由 shadcn CLI 管理：`pnpm --filter @deepsea/web dlx shadcn add <name>`

