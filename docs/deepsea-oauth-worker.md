# deepSea 自托管 OAuth Worker

> 状态：**M1 已实现（apps/worker）** · 关联：topbar「登录」已指向本站 callback
> 编写：2026-08-18（替代原 deepwn 登录 worker 方案 —— 不做跨站登录层，deepSea 自己处理）
> 更新：2026-08-20（存储从纯 KV 拆分为 KV + D1，见 §4a；新增 preferences/互联日志端点）

## 1. 背景与决策

原方案是为 deepwn 组织做「全站统一登录授权 worker」，但复杂度高（站点注册表、站级 JWT 交换、跨站凭据传递）。**简化决策**：

- **deepSea 直接部署到 Cloudflare Workers**（静态资源 + OAuth 逻辑一体）
- OAuth callback 为本站自身路径：**`https://deepc.cn/auth/callback`**
- code 换 token、会话签发由本站 Worker 处理，**不依赖 deepwn**
- 未来若 deepwn 需要统一登录，再做独立登录层（本方案不影响）

```
┌──────────────┐   authorize    ┌───────────────────────┐   OAuth   ┌────────────┐
│  deepSea 前端 │ ─────────────► │  deepc.cn (Worker)   │ ────────► │  GitHub    │
│ (Vite 静态)   │ ◄───────────── │  /auth/callback 等    │   code    │  OAuth App │
└──────────────┘   cookie/JWT   └───────────────────────┘ ◄───────── └────────────┘
                                        │
                          ┌─────────────┴──────────────┐
                          ▼                            ▼
                     Cloudflare KV                Cloudflare D1
                    ┌──────────────┐            ┌──────────────────────┐
                    │ state（CSRF） │            │ users（用户，github_id）│
                    │ deviceGrant   │            │ sessions（多端会话）   │
                    │ 限流计数       │            │ deepc_nodes（设备）   │
                    └──────────────┘            │ deepc_device_tokens  │
                                                 │ deepc_config（配置）  │
                                                 │ interconnect_log     │
                                                 └──────────────────────┘
```

## 2. 域名与部署

| 项 | 值 |
|----|----|
| 域名 | `deepc.cn`（Cloudflare 托管） |
| 运行时 | Cloudflare Workers（静态资源 + 路由逻辑同一 Worker） |
| 存储 | **KV**（state / deviceGrant 收件箱 / 限流计数）+ **D1**（users / sessions / deepc_nodes / deepc_device_tokens / deepc_config / interconnect_log） |
| 密码学 | Web Crypto（AES-GCM 加密 token、ES256 签 JWT） |
| 配置 | GitHub OAuth App（`client_id` / `client_secret`）+ KV namespace + D1 database |

**Assets 路由（wrangler.toml `[assets]`）**：

- `directory = "../web/dist"` + `binding = "ASSETS"`：Vite 构建产物直接作为静态资源
- `not_found_handling = "single-page-application"`：SPA 路由（/plugins、/plugin/...）回退 index.html
- **`run_worker_first`**：只让 `/auth/*` 与 `/ws/signal` 路由先进 Worker（`/auth/login` `/auth/callback` `/auth/me`
  `/auth/logout` `/auth/interconnect-log` `/auth/node/*` `/auth/device-grant*` `/auth/config/*` `/ws/signal`）。
  浏览器导航（`Sec-Fetch-Mode: navigate`）到 `/auth/callback` 若被 Assets SPA 回退拦截会返回
  index.html，OAuth 回调失效。**不要用 `run_worker_first = true`**（所有静态资源都进 Worker，
  浪费计算额度）；路径数组模式下静态资源与 SPA 回退全部由 Assets 免费处理，零 Worker 消耗。

**GitHub OAuth App 配置（一次性）**：

- 授权回调 URL：`https://deepc.cn/auth/callback`
- 权限 scope：`read:user public_repo`（用户资料 + 公开仓库写 discussions，最小授权）
- `client_secret` 只存 Worker 环境变量 Secret，不进前端代码

## 3. Worker 路由设计

| 路由 | 方法 | 说明 |
|------|------|------|
| `/auth/login` | GET | 生成 `state` 存 KV → 302 到 GitHub 授权页（参数：client_id、redirect_uri、scope、state） |
| `/auth/callback` | GET | **GitHub OAuth callback**：校验 `state` → `code` 换 token → 查/建用户（D1 双写 KV）→ 签发会话 → 302 回跳首页 |
| `/auth/me` | GET | 校验会话 cookie（D1 优先 KV 回退）→ 校验 token → 返回用户档案 |
| `/auth/logout` | POST | 销毁会话（删 D1 + KV 会话 + 清 cookie） |
| `/auth/interconnect-log` | GET | 登录用户查自己的互联日志（安全审计） |
| `/auth/node/*` | GET/POST | 设备注册/列表/心跳/移除（register/list/heartbeat/remove） |
| `/auth/device-grant` / `poll` | POST | 设备授权流（登录态签发 device_token / state 换 token） |
| `/auth/config/list` / `put` | GET/POST | 配置同步（账号级 key-value，D1 + DO 推送） |
| `/ws/signal` | WS | 信令信号房（DO 推送 offer/answer + config-changed） |
| `/*` | GET | 静态资源（Vite build 产物；`/` 返回 index.html，SPA 路由回退） |

> 静态托管细节：Worker 直接 serve `dist/` 产物，或前端用 Cloudflare Pages、OAuth 逻辑放 Pages Functions（等价 Worker 运行时）。二选一，本构思按「单一 Worker」描述。

## 4. 存储键设计

**KV（一次性 / 短 TTL）**：

```
state:{stateId}            → { redirectTo, exp }        // 一次性，TTL 7min
deviceGrant:{state}        → <device_token 明文>        // 设备授权收件箱，TTL 5min
ratelimit:{ip}:*           → <计数>                     // 限流（60min / 1s 窗口）
```

**D1（关系型）**：`users`（github_id 主键）、`sessions`（多端）、`deepc_nodes`（设备注册表）、
`deepc_device_tokens`（设备令牌哈希）、`deepc_config`（配置同步）、`interconnect_log`（互联日志）。
详见 `deepsea-auth-migration-evaluation.md`。

**token 缓存（避免重复请求 GitHub）**：

- 同一用户再次登录时，先查 `users` 表的 `token_enc`：
  - 命中且未过期 → 直接复用，**不发 GitHub 请求**
  - 过期 → 走完整 OAuth 流程换新 token，更新 D1 + KV
- token 一律 AES-GCM 加密落库，密钥来自环境变量 Secret（`TOKEN_ENC_KEY` 优先，`GITHUB_CLIENT_SECRET` 兜底）

## 5. 会话与凭据

- **会话 cookie**：`HttpOnly + Secure + SameSite=Lax`，`deepc.cn` 域，短期（如 30d，可续）
- 会话值 = 随机 `sessionId`（D1 sessions 主键 + KV 键，双写过渡），不把 token 直接放 cookie
- `/auth/me` 用 cookie 查会话（D1 优先）→ 读用户档案（D1 优先）→ 返回
- 前端登录后：调 `/auth/me` 渲染头像/昵称，登录按钮变用户菜单；退出调 `/auth/logout`

## 6. 安全设计

- **state 防 CSRF**：/auth/login 生成 `state` 存 KV（TTL 7min，一次性），callback 必须匹配并立即删除
- **redirect_uri 固定**：callback 后只回跳本站首页（或可配置白名单），防开放重定向
- **token 加密**：GitHub token 用 AES-GCM 加密存储（key = 环境变量 Secret）
- **cookie**：`HttpOnly + Secure + SameSite=Lax`，不暴露给 JS
- **限流**：/auth/callback、/auth/me 按 IP 限流（Workers Rate Limiting）
- **审计**：登录/登出/换 token 写 `audit:{date}` 或日志，便于排查
- **密钥轮换**：client_secret、AES 密钥支持双版本平滑轮换

## 7. 目录结构（已实现，apps/worker）

```
deepsea/
├── apps/web/                 # 前端（Vite + React）
│   └── dist/                 # pnpm build 产物（Worker 的 ASSETS 托管）
├── apps/worker/              # Cloudflare Worker（OAuth + 静态资源）
│   ├── src/
│   │   ├── index.ts          # fetch 入口 + 路由分发 + ASSETS 回退
│   │   ├── auth/
│   │   │   ├── login.ts      # GET /auth/login（发起 GitHub OAuth）
│   │   │   ├── callback.ts   # GET /auth/callback（核心：state 校验/code 换 token/建会话）
│   │   │   ├── me.ts         # GET /auth/me（会话 cookie → 用户档案）
│   │   │   ├── logout.ts     # POST /auth/logout（销毁会话）
│   │   │   ├── node.ts       # /auth/node/*（设备注册/列表/心跳/移除 + 配额校验）
│   │   │   ├── device.ts     # /auth/device-grant*（设备授权流）
│   │   │   ├── config.ts     # /auth/config/*（配置同步）
│   │   │   └── preferences.ts # GET /auth/interconnect-log（互联日志）
│   │   ├── durable/
│   │   │   └── signal-room.ts # DO 信号房（WS 推送信令 + config-changed）
│   │   ├── lib/
│   │   │   ├── github.ts     # code 换 token、用户信息、token 三态校验（原生 fetch）
│   │   │   ├── kv.ts         # KV 键设计 + TTL 常量（state / signal / 限流）
│   │   │   ├── d1.ts         # D1 数据访问层（users / sessions / deepc_preferences / interconnect_log）
│   │   │   ├── ratelimit.ts  # 双层限流（频次 + 错误）
│   │   │   ├── crypto.ts     # AES-GCM token 加密/解密（HKDF 派生密钥）
│   │   │   └── cookies.ts    # cookie 解析/序列化
│   │   └── ...
│   ├── migrations/           # D1 迁移 SQL（0001_init.sql）
│   ├── test/                 # vitest（cookies / token 加密）
│   ├── wrangler.toml         # 绑定 deepc.cn + KV + D1 + ASSETS(../web/dist)
│   ├── .dev.vars.example     # client_secret 等本地样例
│   └── package.json
└── docs/deepsea-oauth-worker.md   # 本文档
```

## 8. 与 deepSea 前端的对接点（现状）

- 已落地：`apps/web/src/lib/auth.ts` 导出 `loginUrl()` / `reauthUrl()`，topbar「登录」指向站内
  `/auth/login`（Worker 生成 state 后 302 GitHub，前端不拼 authorize URL、不持有 client_id）
- Worker 已实现（apps/worker）：/auth/login、/auth/callback、/auth/me、/auth/logout +
  /auth/signal/* + /auth/preferences + /auth/interconnect-log + KV + D1 + ASSETS 静态托管
- 前端对接已完成：调 /auth/me 渲染头像/昵称，登录按钮 → 用户菜单；token 失效自动登出

## 9. 后续开发步骤（里程碑）

1. **M1 最小闭环** ✅ Worker 骨架 + /auth/login + /auth/callback + /auth/me + /auth/logout + KV + ASSETS，`wrangler dev` 已验证
2. **M2 前端对接** ✅ 登录态展示（/auth/me → 头像/昵称菜单）、登出、登录跳转回源
3. **M3 加固** ✅ 限流（双层）、token 三态校验、D1 迁移 P1（双写）
4. **M4 生产**：创建 D1 database → wrangler secret 注入 → 绑定 deepc.cn → `pnpm deploy`（先 build 再 deploy）

## 10. 待确认问题

- [ ] GitHub OAuth App 归属：注册在个人还是组织账号？（影响后续管理）
- [ ] 登录态有效期：30d 会话 + 自动续期是否够用？是否需要「记住我」选项
- [ ] 是否需要邮箱验证 / 人工审核用户体系（当前最小化：GitHub 登录即视为用户）
- [ ] KV namespace / D1 database 正式 id 需创建后填入 wrangler.toml（当前为占位）
