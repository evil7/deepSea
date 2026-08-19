# deepSea 自托管 OAuth Worker

> 状态：**M1 已实现（apps/worker）** · 关联：topbar「登录」已指向本站 callback
> 编写：2026-08-18（替代原 deepwn 登录 worker 方案 —— 不做跨站登录层，deepSea 自己处理）

## 1. 背景与决策

原方案是为 deepwn 组织做「全站统一登录授权 worker」，但复杂度高（站点注册表、站级 JWT 交换、跨站凭据传递）。**简化决策**：

- **deepSea 直接部署到 Cloudflare Workers**（静态资源 + OAuth 逻辑一体）
- OAuth callback 为本站自身路径：**`https://deepc.cn/auth/callback`**
- code 换 token、会话签发、KV 缓存全部由本站 Worker 处理，**不依赖 deepwn**
- 未来若 deepwn 需要统一登录，再做独立登录层（本方案不影响）

```
┌──────────────┐   authorize    ┌───────────────────────┐   OAuth   ┌────────────┐
│  deepSea 前端 │ ─────────────► │  deepc.cn (Worker)   │ ────────► │  GitHub    │
│ (Vite 静态)   │ ◄───────────── │  /auth/callback 等    │   code    │  OAuth App │
└──────────────┘   cookie/JWT   └───────────────────────┘ ◄───────── └────────────┘
                                        │
                                        ▼
                                 Cloudflare KV
                          ┌────────────────────────┐
                          │ state（防 CSRF）        │
                          │ 会话（token 加密存储）   │
                          │ 用户档案                │
                          └────────────────────────┘
```

## 2. 域名与部署

| 项 | 值 |
|----|----|
| 域名 | `deepc.cn`（Cloudflare 托管） |
| 运行时 | Cloudflare Workers（静态资源 + 路由逻辑同一 Worker） |
| 存储 | Cloudflare KV（state / 会话 / 用户档案） |
| 密码学 | Web Crypto（AES-GCM 加密 token、ES256 签 JWT） |
| 配置 | GitHub OAuth App（`client_id` / `client_secret`）+ KV namespace |

**Assets 路由（wrangler.toml `[assets]`）**：

- `directory = "../web/dist"` + `binding = "ASSETS"`：Vite 构建产物直接作为静态资源
- `not_found_handling = "single-page-application"`：SPA 路由（/plugins、/plugin/...）回退 index.html
- **`run_worker_first = ["/auth/login", "/auth/callback", "/auth/me", "/auth/logout"]`**：
  选择性 Worker-first —— 只有这 4 个 OAuth 路由先进 Worker（浏览器导航 `Sec-Fetch-Mode: navigate` 到
  /auth/callback 若被 Assets SPA 回退拦截会返回 index.html，OAuth 回调失效）。
  **不要用 `run_worker_first = true`**（所有静态资源请求都进 Worker，浪费计算额度）；
  路径数组模式下静态资源（JS/CSS/字体/图片）与 SPA 回退全部由 Assets 免费处理，零 Worker 消耗。

**GitHub OAuth App 配置（一次性）**：

- 授权回调 URL：`https://deepc.cn/auth/callback`
- 权限 scope：`read:user public_repo`（用户资料 + 公开仓库写 discussions，最小授权）
- `client_secret` 只存 Worker 环境变量 Secret，不进前端代码

## 3. Worker 路由设计

| 路由 | 方法 | 说明 |
|------|------|------|
| `/auth/login` | GET | 生成 `state` 存 KV → 302 到 GitHub 授权页（参数：client_id、redirect_uri、scope、state） |
| `/auth/callback` | GET | **GitHub OAuth callback**：校验 `state` → `code` 换 token → 查/建用户 → 加密存 KV → 签发会话 → 302 回跳首页 |
| `/auth/me` | GET | 校验会话 cookie → 返回用户档案（id/login/email/avatar） |
| `/auth/logout` | POST | 销毁会话（删 KV 会话键 + 清 cookie） |
| `/*` | GET | 静态资源（Vite build 产物；`/` 返回 index.html，SPA 路由回退） |

> 静态托管细节：Worker 直接 serve `dist/` 产物，或前端用 Cloudflare Pages、OAuth 逻辑放 Pages Functions（等价 Worker 运行时）。二选一，本构思按「单一 Worker」描述。

## 4. KV 键设计

```
state:{stateId}            → { redirectTo, exp }        // 一次性，TTL 7min
session:{sessionId}        → { userId, exp }            // 会话，TTL 30d（可续）
user:{githubId}            → { login, email, avatar, tokenEnc, createdAt, updatedAt }
audit:{date}               → [...]                       // 登录/登出审计（可选）
```

**token 缓存（避免重复请求 GitHub）**：

- 同一用户再次登录时，先查 `user:{githubId}` 的 `tokenEnc`：
  - 命中且未过期 → 直接复用，**不发 GitHub 请求**
  - 过期 → 走完整 OAuth 流程换新 token，更新 KV
- token 一律 AES-GCM 加密落 KV，密钥来自环境变量 Secret

## 5. 会话与凭据

- **会话 cookie**：`HttpOnly + Secure + SameSite=Lax`，`deepc.cn` 域，短期（如 7d，可续）
- 会话值 = 随机 `sessionId`（KV 键），不把 token 直接放 cookie
- `/auth/me` 用 cookie 查 KV 会话 → 读用户档案 → 返回
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
│   │   │   └── logout.ts     # POST /auth/logout（销毁会话）
│   │   ├── lib/
│   │   │   ├── github.ts     # code 换 token、用户信息（原生 fetch）
│   │   │   ├── kv.ts         # KV 键设计 + TTL 常量
│   │   │   ├── crypto.ts     # AES-GCM token 加密/解密（HKDF 派生密钥）
│   │   │   └── cookies.ts    # cookie 解析/序列化
│   │   └── ...
│   ├── test/                 # vitest（cookies / token 加密）
│   ├── wrangler.toml         # 绑定 deepc.cn + KV + ASSETS(../web/dist)
│   ├── .dev.vars.example     # client_secret 等本地样例
│   └── package.json
└── docs/deepsea-oauth-worker.md   # 本文档
```

## 8. 与 deepSea 前端的对接点（现状）

- 已落地：`apps/web/src/lib/auth.ts` 导出 `githubOAuthUrl(state)`，topbar「登录」已改为指向
  `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=https://deepc.cn/auth/callback&scope=read:user%20public_repo&state=...`
  （`client_id` 由 `VITE_GITHUB_OAUTH_CLIENT_ID` 注入，未配置时为占位值）
- Worker 已实现（apps/worker，M1 完成）：/auth/login、/auth/callback、/auth/me、/auth/logout + KV + ASSETS 静态托管
- 待开发（M2 前端对接）：调 /auth/me 渲染头像/昵称，登录按钮 → 用户菜单

## 9. 后续开发步骤（里程碑）

1. **M1 最小闭环** ✅ Worker 骨架 + /auth/login + /auth/callback + /auth/me + /auth/logout + KV + ASSETS，`wrangler dev` 已验证
2. **M2 前端对接**：登录态展示（/auth/me → 头像/昵称菜单）、登出、登录跳转回源
3. **M3 加固**：限流、审计、密钥轮换、KV 缓存复用（token 已加密缓存，防重复请求）
4. **M4 生产**：创建 KV namespace → wrangler secret 注入 → 绑定 deepc.cn → `pnpm deploy`（先 build 再 deploy）

## 10. 待确认问题

- [ ] GitHub OAuth App 归属：注册在个人还是组织账号？（影响后续管理）
- [ ] 登录态有效期：30d 会话 + 自动续期是否够用？是否需要「记住我」选项
- [ ] 是否需要邮箱验证 / 人工审核用户体系（当前最小化：GitHub 登录即视为用户）
- [ ] KV namespace 正式 id 需创建后填入 wrangler.toml（当前为占位）
