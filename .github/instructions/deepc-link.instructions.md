---
description: "Use when 开发 deepc-link 互联插件：三模式互联（本地共享/Tunnel 暴露/主站纳管）、TOTP 2FA、cloudflared Quick Tunnel、Device Grant 授权、3081 鉴权代理、前后端分层。covers node 端插件 + Worker auth 边界 + 主站 links 页的架构红线。"
name: "deepc-link 互联架构规范"
applyTo: ["packages/deepc-link/**", "apps/worker/src/**", "apps/web/src/lib/deepc-link/**", "apps/web/src/pages/links.tsx"]
---

# deepc-link 互联架构规范

> 本文档是 deepc-link（深海套装互联底座）的**唯一开发规范 + 红线底稿**，
> 权威方案见 `docs/deepsea-tunnel-bridge-proposal.md`。所有涉及本目录的改动必须遵守。

## 一、开发理念（四条，不可违背）

1. **Worker = auth 最小边界**：`apps/worker` 只承载「身份与授权」——OAuth 登录、设备授权
   （device-grant）、隧道节点纳管（report/list/delete）、审计。**数据面一律 P2P/直连，
   绝不进 Worker**。主站只纳管 URL，不存任何 secret。
2. **插件前后端分层**：`packages/deepc-link` 是 Cordis 插件，天然分两端——
   **前端（browser）只做展示交互**，**后端（node）承载连接层 + 逻辑 + 底层能力**。
3. **能走 P2P/直连绝不走 Worker；能一次性/按需绝不轮询**（额度红线）。
4. **三模式自选 + 本地 TOTP 2FA**：local（本地共享）/ tunnel（CF 暴露）/ managed（主站纳管）；
   安全码 = TOTP secret（本地生成，2FA 应用管理），主站永不接触 secret。

## 二、前后端分层（两条正交链路，务必分清）

| 端 | 运行环境 | 职责 | 准入边界 |
|----|---------|------|---------|
| **插件后端（node）** | dsh host Node 进程（`index.ts` `apply` 启动） | 3081 鉴权代理、cloudflared 托管、Device Grant、TOTP secret、上报 URL | 唯一「真本机」执行者 |
| **插件前端（browser）** | dsh 页面 `127.0.0.1:3080`（`host-ui.ts` 悬浮球） | 只读展示 + 控制：三模式切换/登录/连接/断开/2FA 二维码 | 无 localStorage 之外的逻辑；**不**启动隧道/鉴权 |

| 链路 | 通道 | 承载内容 | 语义 |
|------|------|---------|------|
| **① 主站 links ↔ 插件后端** | 主站 Worker（`/auth/tunnel/*`，仅纳管 URL）+ 数据面 CF Tunnel 直连 3081 | 节点列表/删除 + 远程访问 dsh UI | 远端纳管 + 远程控制 |
| **② 插件前端 ↔ 插件后端** | 后端前缀路由 `/deepc`（`ctx.webServer.register`） | auth/state（token/模式/TOTP secret/连接态） | 同机凭证传递 |

**关键事实（不可回退）**：

- **三模式**（`LinkMode`）：`local`（仅 3081，局域网）/ `tunnel`（+ cloudflared，匿名 Quick
  Tunnel 或自定义域）/ `managed`（+ 登录上报 URL，断链自动重连上报）。用户自选。
- **TOTP secret 由插件本地生成并持久化**（`~/.deepc/totp-secret`，chmod 600），device_token
  持久化（`~/.deepc/device-token`）；**主站 Worker 不存任何 secret**（无 security_code 列、
  无 ticket 签发、无自动过鉴权）。安全码 = TOTP 动态码，用户用 2FA 应用管理，30s 轮换。
- **3081 鉴权代理监听 0.0.0.0**（local 模式局域网可达），反代 3080 + WS hijack，
  `verifyTotp` 校验 6 位码（RFC 6238，±1 步容差），失败 5 次锁 1 小时。
- **远端数据交换规范**：主站 ↔ Worker 的「节点状态」类数据经 `/ws/tunnel-events`
  （TunnelHub DO 广播）；`/auth/tunnel/report|list|delete` 仅管理面 REST。
- **cloudflared 是唯一外部二进制**：GitHub Release 直连下载 + SHA-256 校验 + 子进程托管；
  自动探测自定义域（Named Tunnel config.yml），无则匿名 Quick Tunnel。
- **数据面桥已退役**：不再有 apiProxy 直连 / RTC DataChannel / HTTP 回环——远程访问 dsh UI
  走 CF Tunnel → 3081 鉴权 → 反代 3080。

## 三、红线（禁止事项）

1. **禁止给 Worker 加 `/api/*` 代理路由**——dsh 官方 `/api` 被官方 gateway 独占，数据面走 CF Tunnel。
2. **禁止主站存/代任何 secret**——不存 security_code、不签 ticket、不自动过鉴权；TOTP secret 只在插件本地。
3. **禁止把会话消息/工作区/配置详情落 Worker 服务器存储**——走 CF Tunnel 直传，D1 只存 URL 索引。
4. **禁止复刻官方前端 / DOM snapshot / monkey-patch `fetch`/`WebSocket`**。
5. **禁止插件端在浏览器侧启动隧道/鉴权/派生 secret**——这些全部在 node 后端。
6. **禁止密钥/device_token 落明文 JSON 或 localStorage**——TOTP secret 落盘 chmod 600；token 只在 node 内存 + chmod 600 文件。
7. **禁止手改 `apps/web/src/components/ui/**`**——shadcn CLI 管理。
8. **禁止非必要在 Worker 新增 REST 端点**——节点状态走 `/ws/tunnel-events` WS 帧；仅 report/list/delete 保留 REST。

## 四、节点纳管与在线判定

- 节点无配额限制（Quick Tunnel 免费无限）。
- 在线判定 = 行存在（report 即在线）；delete 硬删即离线。D1 `modified_at` 仅作「最后活跃」展示。
- 无任何 HTTP 心跳；上报即 DO 广播 node_online，删除即广播 node_deleted。

## 五、关键实现锚点（改动前先读源码）

| 关注点 | 文件 |
|--------|------|
| node 端入口 + `/deepc` 路由注册 | `packages/deepc-link/src/index.ts` |
| node 端编排（三模式 + Device Grant + TOTP secret） | `src/host.ts` |
| TOTP 2FA（secret 生成/校验/otpauth URI） | `src/totp.ts` |
| 3081 鉴权代理（反代 + TOTP + 防暴力） | `src/auth-proxy.ts` |
| cloudflared 托管（下载 + 子进程） | `src/cloudflared.ts` |
| 互联编排（三模式 + 上报 + 断链重连） | `src/tunnel.ts` |
| DO 事件订阅（node_deleted） | `src/events.ts` |
| 浏览器端悬浮球（三模式 UI + 2FA 二维码） | `src/host-ui.ts` |
| Worker 隧道节点端点 | `apps/worker/src/auth/tunnel.ts` |
| Worker DO 事件广播 | `apps/worker/src/durable/tunnel-hub.ts` |
| 主站隧道节点 API | `apps/web/src/lib/deepc-link/tunnels.ts` |

## 六、构建与验证

- **单一编译命令（dev/prod 通用）**：node 端打包 `scripts/build.mjs` 注入
  `--define:__DEEPC_SITE_BASE__/__DEEPC_SIGNAL_BASE__`，**默认基址 `https://deepc.cn`**。
- **dev/prod 切换 = 运行时「开发模式」开关**（非编译时）：插件 Sheet 打开「开发模式」→ node 端
  `setDevMode(true)` 把基址解析切到 `http://127.0.0.1:5174`。
- 验证命令：`pnpm --filter deepc-link typecheck` + `node scripts/build.mjs`。
- 插件测试：`node test/build-tests.mjs` 后 `node test/totp.test.mjs` + `node test/auth-proxy.test.mjs`。
- Worker 测试：`pnpm --filter @deepsea/worker test`（tunnel.test.ts 覆盖 report/list/delete）。

