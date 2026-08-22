---
description: "Use when 开发 deepc-bridge 互联插件：操作互联、多端直连、WebRTC/WS 信令、设备注册与授权、配置同步、RTC 数据面桥、前后端分层。covers node 端插件 + Worker auth 边界 + 主站 chatUI 的架构红线。"
name: "deepc-bridge 互联架构规范"
applyTo: ["packages/deepc-bridge/**", "apps/worker/src/**", "apps/web/src/lib/deepc-bridge/**", "apps/web/src/pages/sonar.tsx", "apps/web/src/components/sonar/**"]
---

# deepc-bridge 互联架构规范

> 本文档是 deepc-bridge（深海套装互联底座）的**唯一开发规范 + 红线底稿**，
> 权威方案见 `docs/deepsea-deepc-bridge-plan.md`。所有涉及本目录的改动必须遵守。

## 一、开发理念（四条，不可违背）

1. **Worker = auth 最小边界**：`apps/worker` 只承载「身份与授权」——OAuth 登录、设备授权
   （device-grant）、设备注册（node）、WS 信令（DO 信号房）、账号配置（config）、审计。
   **数据面一律 P2P**，绝不进 Worker。
2. **插件前后端分层**：`packages/deepc-bridge` 是 Cordis 插件，天然分两端——
   **前端（browser）只做展示交互**，**后端（node）承载连接层 + 逻辑 + 底层能力**。
3. **能走 P2P 绝不走 Worker；能走 WS 消息绝不发 HTTP 请求；能一次性/按需绝不轮询**（额度红线）。
4. **结构化事件 + 自实现 chatUI**：不直播 DOM、不复刻官方前端、不 monkey-patch；
   session 事件流是真相，DOM 是渲染结果。

## 二、前后端分层（两条正交链路，务必分清）

| 端 | 运行环境 | 职责 | 准入边界 |
|----|---------|------|---------|
| **插件后端（node）** | dsh host Node 进程（`index.ts` `apply` 启动） | 设备注册/心跳、WS 信令、配置同步、`deepc.*` 底层能力（`node:os`/`node:fs`）、HTTP 控制路由 | 唯一「真本机」执行者 |
| **插件前端（browser）** | dsh 页面 `127.0.0.1:3080`（`host-ui.ts` 悬浮球） | 只读展示：登录态/开关/同步/断开 | 无 localStorage 之外的逻辑；**不**注册/心跳/连信令 |

| 链路 | 通道 | 承载内容 | 语义 |
|------|------|---------|------|
| **① 主站 sonar ↔ 插件后端** | WebRTC DataChannel（WS 信令） | `deepc.*`（os/fs）+ `session.*`/`workspace.*` 本地 API | 远端远程控制 |
| **② 插件前端 ↔ 插件后端** | 后端前缀路由 `/deepc`（`ctx.webServer.register`） | auth/state（token/登录态/开关） | 同机凭证传递 |

**关键事实（不可回退）**：

- token 与 nodeId 一律**由 node 后端注入自持**（`NodeTokenStore` 内存 / `deriveNodeId(hostname)`），
  **禁止浏览器端 localStorage 兜底**；插件端不再使用浏览器指纹 driveId（已删）。
- 信令**唯一通道 = `/ws/signal`（DO 推送）**；HTTP 信箱轮询（`/auth/node/signal/get`）已移除，
  **禁止任何形式退回轮询**。
- 配置快照存 **node 进程内存**（node 无 localStorage），禁止写 localStorage。

## 三、红线（禁止事项）

1. **禁止给 Worker 加 `/api/*` 代理路由**——dsh 官方 `/api` 被官方 gateway 独占（`RpcMethodMap`
   编译期封闭），数据面走 P2P DataChannel。
2. **禁止信令退回轮询**——WS + DO（`SignalRoom`，分区键 `room:{githubId}`）是唯一通道。
3. **禁止把会话消息/工作区/配置详情落 Worker 服务器存储**——走 RTC 直传，D1 只存索引/元数据。
4. **禁止复刻官方前端 / DOM snapshot / monkey-patch `fetch`/`WebSocket`**——已废弃，见 plan §2。
5. **禁止插件端在浏览器侧注册/心跳/连信令/派生 nodeId**——这些全部在 node 后端。
6. **禁止密钥/device_token 落明文 JSON 或 localStorage**——Worker 只见密文（`deriveNodeSignalKey`
   派生的 AES-GCM 加密 SDP）。
7. **禁止手改 `apps/web/src/components/ui/**`**——shadcn CLI 管理。

## 四、节点配额与在线判定

- 每账号最多 3 个 dsh 节点（`MAX_NODES_PER_USER = 3`，worker 端强制）。
- 在线判定权威源 = DO 内存态（WS socket 存活 = online）；D1 `last_seen` 仅 WS 断连时写一次兜底。
- 心跳走 WS 协议层 ping/pong（0 HTTP），不再常驻 HTTP 心跳。

## 五、关键实现锚点（改动前先读源码）

| 关注点 | 文件 |
|--------|------|
| node 端入口 + `/deepc` 路由注册 | `packages/deepc-bridge/src/index.ts` |
| node 端连接层（Device Grant + 注册 + 信令 + deepc.*） | `src/node-host.ts` |
| `deepc.*` 底层能力（os/fs 本地拦截） | `src/deepc-api.ts` |
| 信箱 host（WS 信令被动应答 + 装桥/握手） | `src/mailbox-host.ts` |
| 数据面桥（DC 帧 → LocalApi） | `src/api-bridge.ts` |
| 本地 API（HttpLocalApi，访问 127.0.0.1:3080） | `src/local-api.ts` |
| 设备注册/心跳（token/nodeId 注入） | `src/node-registry.ts` |
| WS 信令客户端（`/ws/signal`） | `src/ws-signaling.ts` |
| 配置同步（D1 + DO 推送，node 内存快照） | `src/config-sync.ts` |
| 浏览器端悬浮球（纯展示，`/deepc/*` 转发） | `src/host-ui.ts` |
| Worker 信令 DO | `apps/worker/src/durable/signal-room.ts` |
| Worker auth 端点（node/device/config） | `apps/worker/src/auth/*.ts` |
| 主站 RTC client（DeepcClient 单例） | `apps/web/src/lib/deepc-bridge/client.ts` |
| 主站设备节点 API | `apps/web/src/lib/deepc-bridge/nodes.ts` |

## 六、构建与验证

- node 端打包 `scripts/build.mjs`：**必须注入 `--define:__DEEPC_SITE_BASE__/__DEEPC_SIGNAL_BASE__`**
  （漏注入会导致运行时 `ReferenceError`，`apply` 抛错、`/deepc` 路由不注册）。
- 验证命令：`pnpm --filter @deepsea/deepc-bridge typecheck` + `node scripts/build.mjs --local`。
- 加载验证：从 `~/.dsh/profiles/web` 目录 `node -e "import('@deepsea/deepc-bridge')"` 看
  `name/inject/apply` 是否正常导出。
