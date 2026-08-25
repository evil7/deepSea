---
name: dsh-deepc-interconnect
description: 'deepc-link 三模式远端互联（本地共享/Tunnel 暴露/主站纳管）+ TOTP 2FA。Use when: 开发/调试 deepc-link 三模式编排、3081 鉴权代理、cloudflared Quick Tunnel/自定义域、Device Grant 授权、主站纳管 URL、TOTP secret 注入。'
argument-hint: '要处理的互联场景，例如 "TOTP 2FA 鉴权" 或 "断链自动重连上报" 或 "自定义域探测"'
user-invocable: true
---

# deepc-link 三模式远端互联

## 目标

为 deepSea 的「深海套装互联底座」提供领域知识：deepc-link 插件如何把本地 dsh host
经 3081 鉴权代理（TOTP 2FA）+ cloudflared Quick Tunnel 暴露，并可选登录主站纳管 URL。

## 何时使用

- 开发 / 调试 deepc-link 的三模式编排与前后端分层
- 处理 3081 鉴权代理（TOTP 2FA + 反代 + WS hijack + 防暴力）
- 处理 cloudflared 托管（下载 + 匿名 Quick Tunnel / 自定义域自动探测）
- 处理 Device Grant 授权 / 主站纳管 URL / 断链自动重连上报
- 定位主站 /links ↔ Worker ↔ 插件 的接线问题

## 核心架构（唯一权威：`docs/deepsea-tunnel-bridge-proposal.md`）

### 1. 三种互联模式（用户自选，递进）

| 模式 | 能力 | 登录 | CF |
|------|------|------|----|
| local | 仅 3081（TOTP 2FA），局域网访问 | 否 | 否 |
| tunnel | local + cloudflared（匿名 Quick Tunnel / 自定义域） | 否 | 是 |
| managed | tunnel + 登录上报 URL，断链自动重连上报 | 是 | 是 |

### 2. TOTP 2FA（本地生成，主站零 secret）

- secret 插件本地生成（20 字节 base32），持久化 `~/.deepc/totp-secret`（chmod 600）。
- 用户 2FA 应用扫码/手动绑定；动态码 30s 轮换。
- 3081 用 `verifyTotp(secret, code)` 校验（RFC 6238，HMAC-SHA1，±1 步容差）。
- 前端 6 位分组输入 `[][][] - [][][]`；失败 5 次锁 1 小时。
- 主站 Worker 只纳管 URL，不存 secret、不签 ticket、不代过鉴权。

### 3. 3081 鉴权代理

- 监听 `0.0.0.0:3081`，反代 dsh 3080（HTTP）+ WS hijack 透传。
- 无 cookie → 401 + 内置鉴权页（6 位 2FA 输入）→ POST /__deepc_auth → Set-Cookie → 302。

### 4. cloudflared 托管

- GitHub Release 下载（pinned + SHA-256）→ `~/.deepc/bin/cloudflared` → 子进程托管。
- 匿名 Quick Tunnel 默认；自定义域（Named Tunnel config.yml + CF_TUNNEL_DOMAIN）自动探测。

### 5. 主站 Worker（纯管理面）

- `POST /auth/tunnel/report`（上报 URL）/ `GET /auth/tunnel/list` / `POST /auth/tunnel/delete`。
- `/ws/tunnel-events`（TunnelHub DO 广播 node_online/offline/deleted）。
- D1 `deepc_tunnels` 无 security_code 列。

## 红线（禁止事项，逐条对照）

1. 禁止给 Worker 加 `/api/*` 代理路由（数据面走 CF Tunnel）。
2. 禁止主站存/代任何 secret（无 security_code、无 ticket、无自动过鉴权）。
3. 禁止会话/工作区/配置详情落 Worker（走 CF Tunnel 直传，D1 只存 URL）。
4. 禁止复刻官方前端 / DOM snapshot / monkey-patch fetch/WebSocket。
5. 禁止插件端在浏览器侧启动隧道/鉴权/派生 secret（全部在 node 后端）。
6. 禁止 TOTP secret / device_token 落明文（落盘 chmod 600）。
7. 禁止手改 `apps/web/src/components/ui/**`。
8. 禁止非必要在 Worker 新增 REST 端点（节点状态走 /ws/tunnel-events WS 帧）。

## 关键源码锚点

| 关注点 | 文件 |
|--------|------|
| node 端入口 + `/deepc` 路由 | `packages/deepc-link/src/index.ts` |
| 三模式编排 + Device Grant + TOTP secret | `src/host.ts` |
| TOTP 2FA | `src/totp.ts` |
| 3081 鉴权代理 | `src/auth-proxy.ts` |
| cloudflared 托管 | `src/cloudflared.ts` |
| 互联编排 + 上报 + 断链重连 | `src/tunnel.ts` |
| DO 事件订阅 | `src/events.ts` |
| 悬浮球 UI | `src/host-ui.ts` |
| Worker 隧道端点 | `apps/worker/src/auth/tunnel.ts` |
| Worker DO 广播 | `apps/worker/src/durable/tunnel-hub.ts` |
| 主站节点 API | `apps/web/src/lib/deepc-link/tunnels.ts` |

## 已知坑（务必规避）

- node 端打包漏 `--define:__DEEPC_SITE_BASE__/__DEEPC_SIGNAL_BASE__` → 运行时
  `ReferenceError`、`apply` 抛错、`/deepc` 路由不注册。构建时注入默认基址 `https://deepc.cn`，
  一个编译命令通用 dev/prod；本地联调靠「开发模式」开关切到 `http://127.0.0.1:5174`。
- TOTP 校验必须用 `verifyTotp`（±1 步容差，常量时间比较），不能直接字符串比对。
- 3081 监听 `0.0.0.0`（local 模式局域网可达）；测试 mock 上游要避开真实 dsh 3080 端口。
- 失败锁定是「secret 级全局」（remoteAddress 恒为本地 cloudflared，IP 限速无效）；5 次锁 1 小时。
- cloudflared 断链 → `onExit` 回调 → 自动重连 + 重新上报（managed 模式）；Quick Tunnel URL 重启漂移。
- 自定义域探测：`~/.deepc/cloudflared/config.yml` 存在 + `CF_TUNNEL_DOMAIN` 环境变量才启用；否则匿名。

## 完成标准

- [ ] 不违反任一条红线
- [ ] 改动经 `typecheck` + `build`（单一命令）+ 测试（`node test/totp.test.mjs` / `auth-proxy.test.mjs` / `pnpm --filter @deepsea/worker test`）
- [ ] 结论沉淀到 `/memories/repo/` 对应记忆文件
