---
name: dsh-deepc-interconnect
description: 'deepc-link 操作互联 + 多端直连架构。Use when: 开发/调试 deepc-link 前后端分层、WebRTC 数据面桥、WS+DO 信令、设备注册与授权、配置同步、RTC 直连、nodeId/token 注入、chatUI 数据面。'
argument-hint: '要处理的互联场景，例如 "多端直连信令" 或 "RTC 数据面桥" 或 "设备授权流"'
user-invocable: true
---

# deepc-link 互联架构

## 目标

为 deepSea 的「深海套装互联底座」提供领域知识：deepc-link 插件如何把本地 dsh host 的
能力经加密 RTC 通道暴露给 deepc 主站，实现**操作互联**（远程控制）与**工程同步**（配置同步）。

## 何时使用

- 开发 / 调试 deepc-link 的前后端分层与两条链路
- 处理 WebRTC DataChannel 数据面桥（unary / subscribe / downstream）
- 处理 WS + Durable Objects 信令（offer / answer 推送）
- 处理设备注册 / 心跳 / Device Grant 授权 / 配置同步
- 定位主站 chatUI ↔ RTC ↔ 本地 dsh API 的接线问题

## 核心架构（唯一权威：`docs/deepsea-deepc-bridge-plan.md`）

### 1. 前后端分层（两条正交链路）

| 链路 | 通道 | 承载 | 语义 |
|------|------|------|------|
| ① 主站 links ↔ 插件后端 | WebRTC DataChannel（WS 信令） | `deepc.*` + `session.*`/`workspace.*` | 远端远程控制 |
| ② 插件前端 ↔ 插件后端 | `/deepc` 前缀路由（`ctx.webServer.register`） | token/登录态/开关 | 同机凭证传递 |

- **前端（`host-ui.ts`，browser）只做展示**：登录态/开关/同步/断开经 `/deepc/*` 转发后端。
- **后端（`index.ts`/`node-host.ts`，node）承载一切逻辑**：Device Grant、注册/心跳、WS 信令、
  `deepc.*` 能力（`node:os`/`node:fs`）、配置同步。
- token/nodeId **由 node 后端注入自持**（`NodeTokenStore` 内存 / `deriveNodeId(hostname)`），
  **禁止浏览器端 localStorage 兜底**。

### 2. 信令（唯一通道：WS + DO，禁止轮询）

- `createWsSignalClient`（插件端）→ `/ws/signal?nodeId&token`，DO `SignalRoom`（分区键
  `room:{githubId}`）按 nodeId 推送密文 offer/answer。
- **HTTP 信箱轮询已整体移除（A2）**——任何「退回轮询」都是红线违反（浪费 Worker 额度）。
- 认证：浏览器 WS 无法设 Authorization → token 经 query 传（wss 加密）；主站同源 cookie。

### 3. 数据面桥（RTC 直连，不经 Worker）

- `mailbox-host.ts` 建 DC 后 `installApiBridge(dc, api)` + `installHostHandshake(dc, api)`。
- `apiFactory = (base) => wrapLocalApi(new HttpLocalApi(base))`：`deepc.*` 本地拦截，其余转发
  `127.0.0.1:3080`（dsh 本地 API）。
- 帧协议：`unary` / `unary-result` / `subscribe` / `downstream` / `downstream-end` / `control`（ping/pong/bye）。

### 4. 底层能力（`deepc-api.ts`）

- `deepc.os.hostname`、`deepc.fs.roots`、`deepc.fs.listDirectories`——在 node 进程内用
  `node:os`/`node:fs` 执行，服务「新建工作区枚举系统路径」（主站 `FolderPicker` 调用）。

### 5. 配置同步（D1 权威 + DO 推送）

- 权威源 = D1 `deepc_config`（LWW + worker 单调时间戳）；通知 = DO 广播 `config-changed`。
- 插件端 `config-sync.ts`：本地快照存 **node 进程内存**，收到通知才拉增量（since 下推 SQL，零轮询）。

## 红线（禁止事项，逐条对照）

1. 禁止给 Worker 加 `/api/*` 代理路由（dsh 官方 gateway 独占，数据面走 P2P）。
2. 禁止信令退回轮询（WS + DO 是唯一通道）。
3. 禁止会话消息/工作区/配置详情落 Worker 存储（走 RTC 直传）。
4. 禁止复刻官方前端 / DOM snapshot / monkey-patch `fetch`/`WebSocket`。
5. 禁止插件端在浏览器侧注册/心跳/连信令/派生 nodeId。
6. 禁止密钥/device_token 落明文（Worker 只见 AES-GCM 密文）。
7. 禁止手改 `apps/web/src/components/ui/**`。

## 关键源码锚点

| 关注点 | 文件 |
|--------|------|
| node 端入口 + `/deepc` 路由 | `packages/deepc-link/src/index.ts` |
| node 端连接层 | `src/node-host.ts` |
| `deepc.*` 能力 | `src/deepc-api.ts` |
| 信箱 host（WS 应答 + 装桥） | `src/mailbox-host.ts` |
| 数据面桥 | `src/api-bridge.ts` |
| WS 信令客户端 | `src/ws-signaling.ts` |
| 设备注册/心跳 | `src/node-registry.ts` |
| 配置同步 | `src/config-sync.ts` |
| Worker 信令 DO | `apps/worker/src/durable/signal-room.ts` |
| 主站 RTC client | `apps/web/src/lib/deepc-link/client.ts` |
| 主站设备节点 API | `apps/web/src/lib/deepc-link/nodes.ts` |

## 已知坑（务必规避）

- node 端打包漏 `--define:__DEEPC_SITE_BASE__/__DEEPC_SIGNAL_BASE__` → 运行时
  `ReferenceError`、`apply` 抛错、`/deepc` 路由不注册。
- `respondMailboxOffer` 必须**先投 answer 再 `awaitSession()`**（顺序反了会死锁）。
- `disconnect` 前发 `deepc:bye` 控制帧，否则对端误判「意外断开」自动重连，断开无效。
- cordis 无 `ctx.on('dispose')`，清理用 `ctx.effect(() => ... return disposer)`。
- node-datachannel 的 host 与 client 建连必须**并发**（串行会 datachannel 超时）。

## 完成标准

- [ ] 不违反任一条红线
- [ ] 改动经 `typecheck` + `build --local` + 端到端验证
- [ ] 结论沉淀到 `/memories/repo/` 对应记忆文件
