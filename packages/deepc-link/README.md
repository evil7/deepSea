# deepc-link

deepc-link —— deepc 本地插件 + 远程 RTC 通信中间件（**多端互联 + 工程同步**）。

## 定位

deepc-link 是「深海套装」的本地执行器与互联底座，核心是 **`deepc-link` 中间件**
（安全加密 + 自动分包 + 远程 RTC 通信），在其上实现两个语义正交的功能：

| 功能 | 语义 | 一句话 |
|------|------|--------|
| **多端互联** | 远程控制 | deepc 主站自实现 chatUI，经加密 RTC 通道调本地 dsh host API |
| **工程同步** | 数据迁移/备份 | 登录后把本地工作区 + 聊天记录经同一加密 RTC 通道实时传输 |

**核心原则**：不复刻官方前端、不寄生快照、不直播 DOM；chatUI 只调 dsh 稳定 API，
接触面收敛到「API 契约 + RTC 通道」两个稳定底座。

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

- **S0（当前）**：目录已从 `deepc` 改名 `deepc-link`，镜像/快照/复刻方案已清理。
- S1：底座打通（`session.ts` 换 node-datachannel，headless ↔ 浏览器一条 DataChannel）。
- S2：多端互联（自实现 chatUI + `WebRtcApiClient`）。
- S3：工程同步（工作区 + 聊天记录增量传输）。
- S4：账号能力（登录触发 + 互联日志 + 自定义加密 key）。

## 构建（单一命令，dev/prod 通用）

一个编译命令产出**同一份通用插件**，运行时用「开发模式」开关在 dev/prod 之间切换后端：

```bash
pnpm plugin:build                       # = pnpm --filter deepc-link build（默认基址 https://deepc.cn）
pnpm plugin:pack                        # 构建 + 打 tgz 到 packages/deepc-link/
```

- **默认（prod）**：后端 = `https://deepc.cn`（生产 Worker）。
- **本地 dev 联调**：在插件悬浮球 Sheet 打开 **「开发模式」** 开关 → 插件把后端切到
  `http://127.0.0.1:5174`（vite 代理 `/auth/*` `/ws/*` `/api/*` 到本地 worker 8787），
  无需单独编译 `--local` 产物。

## 安装

```bash
# 生产（基址 https://deepc.cn）
dsh plugin --profile web add deepc-link

# 本地联调：构建 + 打 tgz + 安装
pnpm plugin:pack
dsh plugin --profile web add ./packages/deepc-link/deepc-link-0.0.1.tgz
# 安装后在插件 Sheet 打开「开发模式」即连本地后端
```

## 发布

```bash
pnpm plugin:release                     # 自动 build（deepc.cn 默认基址）+ npm publish
```

> `prepublishOnly` 会在 publish 前自动执行构建（默认基址 `https://deepc.cn`）；`release` = `pnpm publish`。
