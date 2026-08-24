# deepc-link

> [![npm](https://img.shields.io/npm/v/deepc-link)](https://www.npmjs.com/package/deepc-link)
> DSH 多端互联插件——WebRTC 加密通道远程控制本地 DSH host。

deepc-link 是「深海套装」的本地执行器与互联底座，核心是 **`deepc-link` 中间件**
（安全加密 + 自动分包 + 远程 RTC 通信），在其上实现两个语义正交的功能：

| 功能 | 语义 | 一句话 |
|------|------|--------|
| **多端互联** | 远程控制 | deepc 主站自实现 chatUI，经加密 RTC 通道调本地 dsh host API |
| **工程同步** | 数据迁移/备份 | 登录后把本地工作区 + 聊天记录经同一加密 RTC 通道实时传输 |

**核心原则**：不复刻官方前端、不寄生快照、不直播 DOM；chatUI 只调 dsh 稳定 API，
接触面收敛到「API 契约 + RTC 通道」两个稳定底座。

### 一句话本质

本地 dsh 端的插件（node 端）就像一个「**封装 Agent**」：把官方 dsh API 封装成一条
**RTC 数据通道**，让远端 `deepc.cn/link` 控制端经这条通道**远端控制**本地 dsh。
而插件自带的前端（`host-ui.ts`）本身**不是一个前端应用**，它本质上只是——
1. 这层后端 API 封装的一个**简单可见面**（悬浮球 + 快速设置卡片）；
2. 主要服务于远端 `deepc.cn/link` 控制端（chatUI 数据面）。

> 即：**前端悬浮球不是产品主体，后端 API 封装 + RTC 数据通道才是**。
> 前端只经 `/deepc/*` 调后端执行登录/开关/同步/断开，不自持业务状态。

详见规划文档：`docs/deepsea-deepc-bridge-plan.md`。

## 目录

```
packages/deepc-link/
├── package.json        # dsh.bundle.patch → cordis.patch.yml；peerDeps @deepseek-ai/cordis
├── cordis.patch.yml    # 组合包：挂载 deepc-link node 端插件
├── tsconfig.json       # 继承根风格，strict
└── src/
    ├── index.ts        # node 端入口：启动 node-host + 注入 ctx.apiProxy → toFetchHandler → 中间件
    ├── node-host.ts    # node 端连接层：Device Grant 登录/设备注册/心跳/WS 信令/deepc.* 能力
    ├── node-registry.ts# 设备注册：nodeId=hostname 派生，token 注入
    ├── host-ui.ts      # browser 端悬浮球 Sheet：纯展示，经 /deepc/* 调后端
    ├── client/
    │   └── index.ts    # browser 端入口：bootstrapHostUi 注入互联悬浮球
    └── （底座）crypto / signaling / heartbeat / transfer / protocol / session
```

## 设备身份模型

- **nodeId**：插件后端（node 端）由主机 `hostname` SHA-256 派生的确定性 UUID v4（同主机 = 同 ID），
  见 `node-host.ts` 的 `deriveNodeId`；worker upsert 不重复创建。
- **设备名**：默认取主机 `hostname`（`os.hostname()`），用户可改。
- **Console（主站控制端）**：以 GitHub 账号派生确定性 nodeId（同账号 = 同身份，不随设备变化）。

> 插件端 nodeId 在后端（node 进程）派生，token 亦由后端注入自持——浏览器端（host-ui）只做展示，
> 不参与注册/心跳/信令/派生（见 `docs/deepsea-deepc-bridge-plan.md` §3.4）。

## 阶段

- ✅ **S0**：包名统一为 `deepc-link`，已发布到 [npm](https://www.npmjs.com/package/deepc-link)。
- **S1（当前）**：底座打通（`session.ts` 换 node-datachannel，headless ↔ 浏览器一条 DataChannel）。
- S2：多端互联（自实现 chatUI + `WebRtcApiClient`）。
- S3：工程同步（工作区 + 聊天记录增量传输）。
- S4：账号能力（登录触发 + 互联日志 + 自定义加密 key）。

## 安装

**从 npm 安装（推荐）**：

```bash
dsh plugin --profile web add deepc-link
```

**从本地 tgz 安装（联调）**：

```bash
pnpm plugin:pack                                              # 构建 + 打 tgz
dsh plugin --profile web add ./packages/deepc-link/deepc-link-0.0.1.tgz
# 安装后在插件 Sheet 打开「开发模式」即连本地后端
```

## 构建

```bash
pnpm plugin:build                       # = pnpm --filter deepc-link build（默认基址 https://deepc.cn）
pnpm plugin:pack                        # 构建 + 打 tgz 到 packages/deepc-link/
```

- **默认（prod）**：后端 = `https://deepc.cn`（生产 Worker）。
- **本地 dev 联调**：在插件悬浮球 Sheet 打开 **「开发模式」** 开关 → 插件把后端切到
  `http://127.0.0.1:5174`（vite 代理 `/auth/*` `/ws/*` `/api/*` 到本地 worker 8787），
  无需单独编译 `--local` 产物。

## 发布

发布到 npm 需要设置 `NPM_TOKEN` 环境变量（granular access token，勾选 bypass 2FA）。

```bash
pnpm plugin:release                     # 自动 build + npm publish（通过 .npmrc 注入 NPM_TOKEN）
```

> `prepublishOnly` 会在 publish 前自动执行构建；token 通过 `packages/deepc-link/.npmrc` 自动注入。
