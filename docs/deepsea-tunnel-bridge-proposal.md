# deepc 远端互联 —— 三模式自选 + 本地 TOTP 2FA（实施定稿）

> 状态：**已定稿（三模式，主站仅纳管 URL）** · 编写：2026-08-26
> **deepc-link 作为 dsh 插件壳**：自研 3081 轻量鉴权 webserver（TOTP 2FA）、
> 自动探测下载 cloudflared（SHA-256 校验 + 子进程托管）、负责登录（Device Grant）、
> 启动匿名 Quick Tunnel（或自定义域）并上报 URL。
> **安全码改为本地 TOTP 2FA**：插件本地生成 TOTP secret（持久化到 ~/.deepc），
> 用户用任意 2FA 应用（Google Authenticator 等）扫码绑定，动态码 30s 轮换。
> 主站 Worker **只纳管 URL 地址**，不存任何 secret —— 最终安全由用户本地掌控。
> 关联：`deepsea-oauth-worker.md`（OAuth/D1）· `deepsea-deepc-bridge-plan.md`（已退役）

---

## 1. 三种互联模式（用户自选，递进）

| 模式      | 能力                                                                 | 需要登录 | 需要 CF |
| --------- | -------------------------------------------------------------------- | -------- | ------- |
| **1. local**   本地域内共享 | 仅 3081 鉴权代理（TOTP 2FA），监听 0.0.0.0，局域网访问 `http://<本机IP>:3081` | 否 | 否 |
| **2. tunnel**  CF Tunnel 暴露 | local + cloudflared。自动探测：有自定义域配置（Named Tunnel）则用自定义域；否则匿名 Quick Tunnel（xxx.trycloudflare.com） | 否 | 是 |
| **3. managed** 主站纳管    | tunnel + 登录 deepc 主站上报最新 URL；cloudflared 断链自动重连并重新上报，登录账号即可查到最新地址 | 是 | 是 |

用户可自选任一模式。安全码（TOTP secret）贯穿三模式，由本地生成并管理。

## 2. 鉴权设计：本地 TOTP 2FA

- **secret 生成**：插件本地生成 20 字节随机 secret（base32，RFC 4648），持久化到
  `~/.deepc/totp-secret`（chmod 600）。首次启动自动生成，可手动「重新生成安全码」。
- **用户绑定**：插件 Sheet 展示 otpauth:// URI 二维码 + secret 明文（分组显示），
  用户用 2FA 应用扫码/手动输入绑定。
- **动态码校验**：3081 鉴权代理用 `verifyTotp(secret, code)` 校验 6 位动态码
  （RFC 6238，HMAC-SHA1，30s 窗口，±1 时间步容差，常量时间比较）。
- **前端输入**：`[][][] - [][][]` 6 位分组输入（类似 2FA 的 UI），自动聚焦/退格跳格。
- **防暴力**：失败 5 次锁定 1 小时（secret 级全局，remoteAddress 恒为本地
  cloudflared/局域网，基于 IP 限速无效）+ 常量时间比较 + 本地审计日志。
- **自动过鉴权**：鉴权成功 Set-Cookie `dc_site`（HttpOnly; SameSite=None; Secure;
  Partitioned; 7 天），后续请求/WS 免重复输入。
- **最终安全由用户本地掌控**：主站 Worker 不存 secret、不签 ticket、不代过鉴权。

## 3. 3081 鉴权代理

- 独立轻量 Node webserver（~300 行），反代 dsh 3080（HTTP）+ WS hijack 透传。
- 无 cookie → 401 + 内置鉴权页（6 位 2FA 输入）。
- `POST /__deepc_auth`（code=6 位动态码）→ 校验 → Set-Cookie → 302 回原路径。
- 监听 `0.0.0.0:3081`（local 模式局域网可达；tunnel/managed 由 cloudflared 转发）。

## 4. cloudflared 托管

- 自动探测 GOOS/GOARCH → GitHub Release 官方直连下载（pinned 版本 + SHA-256 校验）
  → 落盘 `~/.deepc/bin/cloudflared` → 子进程托管（崩溃自动拉起 + 断链回调）。
- **匿名 Quick Tunnel**（默认）：`cloudflared tunnel --url http://127.0.0.1:3081`，
  免登录/API key，输出随机 `xxx.trycloudflare.com`。
- **自定义域**（可选）：用户设定 CF token/zone 配置 Named Tunnel，`~/.deepc/cloudflared/config.yml`
  + `CF_TUNNEL_DOMAIN` 环境变量。自动探测：有则用自定义域，无则匿名。设置文档见附录 A。

## 5. 主站 Worker（纯管理面，仅纳管 URL）

| 路由                        | 说明                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `POST /auth/tunnel/report`  | 插件上报最新 URL（upsert，防膨胀；仅 URL，不存 secret）→ DO 广播 node_online |
| `GET /auth/tunnel/list`     | 当前用户节点列表（前端 /links）                                        |
| `POST /auth/tunnel/delete`  | 硬删 D1 行（DELETE）→ DO 广播 node_deleted                             |
| `GET /ws/tunnel-events`     | WS：连 TunnelHub DO，订阅节点状态（前端 /links + 插件）                 |

D1 `deepc_tunnels`（每节点一行，node_id PK + upsert 原地改；删除硬删）：

```sql
node_id TEXT PK | github_id INT | node_name TEXT
url TEXT | status (connected)
created_at INT | modified_at INT
```

**无 security_code 列** —— 主站不存任何 secret，只存 URL。

## 6. 断链自动重连（managed 模式）

- cloudflared 子进程异常退出 → `onExit` 回调 → tunnel manager 自动重新 connect
  （重新启动 cloudflared → 重新上报最新 URL）。
- Quick Tunnel URL 重启漂移 → 每次重连上报覆盖最新 URL，主站始终显示最近一次。
- 主站删除节点 → DO 广播 `node_deleted` → 插件收到停止本地 cloudflared。

## 7. 前端（/links）

- 节点卡片：名称 + 状态 + URL + 「打开节点」（新窗口，进入 3081 鉴权页输 2FA 码）+ 删除。
- WS 订阅 TunnelHub DO → 节点状态实时更新（不轮询）。
- 不自动过鉴权（主站无 secret），由用户本地 2FA 应用生成动态码完成验证。

## 8. 插件架构（deepc-link 壳）

```
deepc-link（dsh 插件，Cordis）
  ├─ 登录模块：Device Grant → device_token（managed 模式；持久化 ~/.deepc/device-token）
  ├─ TOTP 模块：secret 生成/持久化/校验（totp.ts）
  ├─ 3081 鉴权代理：反代 3080 + WS 透传 + TOTP 2FA + 防暴力（auth-proxy.ts）
  ├─ cloudflared 托管：探测→下载(SHA-256)→子进程管理（cloudflared.ts）
  ├─ 互联编排：三模式 + 断链重连 + 上报 URL（tunnel.ts + host.ts）
  └─ 悬浮球 UI：三模式切换 + 2FA 二维码 + URL 展示（host-ui.ts）
```

统一流程（managed 模式）：
`login`（Device Grant）→ 启动 3081（注入 TOTP secret）→ 启动 cloudflared
（匿名/自定义域）→ 解析 URL → `POST /auth/tunnel/report`（上报 URL）→ 建立 DO 事件订阅。

## 9. 费用

Tunnel **$0**（匿名 Quick Tunnel 无限）；Worker/D1/DO 仅管理面低频流量，免费额度内。

## 附录 A：自定义域设置文档

1. 安装 cloudflared 并登录：`cloudflared tunnel login`
2. 创建命名隧道：`cloudflared tunnel create deepc-<hostname>`（生成 credentials）
3. 配置 `~/.deepc/cloudflared/config.yml`：
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: ~/.deepc/cloudflared/<tunnel-id>.json
   ingress:
     - hostname: deepc.example.com
       service: http://localhost:3081
     - service: http_status:404
   ```
4. 路由 DNS：`cloudflared tunnel route dns <name> deepc.example.com`
5. 设置环境变量 `CF_TUNNEL_DOMAIN=deepc.example.com`
6. 插件自动探测到 config.yml + CF_TUNNEL_DOMAIN 即使用自定义域；否则匿名 Quick Tunnel。

## 附录 B：实现映射（无残留切换，已执行）

- **插件删除**（13 个 P2P 文件）：api-bridge / local-api / deepc-api / host-handshake /
  session / protocol / transfer / polyfill / node-signaling / ws-signaling / mailbox-host /
  config-sync / node-registry + 依赖 node-datachannel。
- **插件新增**：totp.ts（TOTP 2FA）、auth-proxy.ts（3081 鉴权）、cloudflared.ts（托管）、
  tunnel.ts（三模式编排）、host.ts（壳）、events.ts（DO 订阅）。
- **Worker 删除**：signal-room.ts / node.ts / config.ts / `/ws/api-link` / `/auth/node/*` /
  `/auth/config/*` / deepc_nodes / deepc_config / security_code 列。
- **主站删除**：chatUI 全家（components/link/* + hooks/use-deepc-link + pages/link-detail）+
  旧 deepc-link lib（client/crypto/device-fingerprint/fold/nodes/protocol/ws-signaling）。
- **保留**：OAuth 登录 + device-grant 流 + crypto.ts（generateConnectId）+ D1
  users/sessions/deepc_device_tokens + interconnect_log 审计。
