# deepSea Auth 迁移升级评估（D1 + KV 分工）

> 状态：**已实施 P1（双写）** · 关联：`deepsea-oauth-worker.md`、`deepsea-deepc-bridge-plan.md`
> 编写：2026-08-20 · 目标：评估「用户/会话/deepc 偏好迁 D1、KV 只留临时口令信令」的可行性与方案
>
> ⚠️ **过时说明（2026-08-21）**：本文档部分内容已演进。①「临时口令信令」（方案 B）已移除；
> ② `deepc_preferences` 表已删除（配置迁 `deepc_config`，见 config-sync.md）；③ 多端直连信令
> 已从「D1 账号 roomId」演进为「nodeId + WS/DO 信号房」（见 signaling.md）。本文档保留
> 「D1 vs KV 决策分析」（§3）的核心原则，现状盘点（§2）以下方修订为准。

## 1. 背景与目标

当前 Auth 全部落在 Cloudflare KV（`state`/`session`/`user`/`signal` 四个键族），存在三类问题：

1. **KV 语义错配**：`user:{githubId}` 需要「按用户维度」读取/更新/审计，而 KV 是纯键值，
   没有关系查询、事务、索引，无法支撑「多端会话管理」「互联日志」「deepc 偏好管理」。
2. **留存与粘滞性不足**：登录态依赖「HttpOnly cookie + KV session」，无「多端在线状态」、
   无「设备列表」，用户每次关标签页即丢上下文，体验割裂。
3. **数据面能力受限**：临时口令信令是「一次性消费 + 短 TTL + 高频键值」，KV 天然契合；
   但用户/会话是「关系型 + 需聚合查询」，KV 是错误工具。

**目标**：将「用户/会话/deepc 偏好/互联日志」迁移到 **Cloudflare D1**（SQLite，关系型），
KV 退化为**单一职责**——临时口令分享互联的信令（一次性密文透传）。登录方式**仅保留 GitHub OAuth**；
账户档案直接用 GitHub，不重复存储、不建独立 profile 页。

## 2. 现状盘点（apps/worker）

### 2.1 KV 键族与职责

| 键族 | 职责 | 特性 | 迁移去向 |
|------|------|------|----------|
| `state:{id}` | OAuth 防 CSRF 一次性 state | 短 TTL(7min)、一次性 | **KV（保留）** |
| `session:{id}` | 登录会话（HttpOnly cookie 引用） | TTL 30d、单点读 | **D1** |
| `user:{githubId}` | 用户档案 + 加密 token 缓存 | 按用户读/写 | **D1** |
| `deviceGrant:{state}` | 设备授权收件箱（device_token 明文） | 短 TTL、一次性消费 | **KV（保留）** |

> 已删除：`signal:{roomId}:{kind}`（临时口令信令，随临时连接移除）；
> `nodeSignal:{nodeId}:{kind}`（信箱信令，随 WS+DO 贯通后 A2 移除）。

### 2.2 现有接口

| 路由 | 方法 | 现状 | 迁移后 |
|------|------|------|--------|
| `/auth/login` | GET | 生成 state → 302 GitHub | 不变（state 仍 KV） |
| `/auth/callback` | GET | 校验 state → 换 token → 建会话 | 用户/会话写 D1 |
| `/auth/me` | GET | cookie → KV session → 用户档案 | D1 查询 + token 校验 |
| `/auth/logout` | POST | 删 session | D1 删 session |
| `/auth/node/*` | GET/POST | 设备注册/列表/心跳/移除 | D1（deepc_nodes） |
| `/auth/device-grant*` | POST | 设备授权流 | D1（token 哈希）+ KV（收件箱） |
| `/auth/config/*` | GET/POST | 配置同步 | D1（deepc_config）+ DO 推送 |
| `/ws/signal` | WS | 信令信号房 | DO 推送（offer/answer/config-changed） |

### 2.3 token 架构现状（2026-08-20 已加固）

- token AES-GCM 加密存 KV（`TOKEN_ENC_KEY` 优先，`GITHUB_CLIENT_SECRET` 兜底）。
- 前端 octokit 401 检测 → 广播 `deepsea:auth-expired` → 统一登出。
- `sessionStorage` 缓存带 TTL（10min）。
- Worker `/auth/me` 解密后 `verifyToken` 三态校验（valid/invalid/unknown）。
- 这些加固逻辑**与存储后端无关**，迁移 D1 时原样保留。

## 3. D1 vs KV 决策分析

### 3.1 为什么用户/会话迁 D1

| 需求 | KV 能否满足 | D1 优势 |
|------|------------|---------|
| 按用户查全部会话（多端下线） | ❌ 需遍历 `session:*` | SQL `WHERE github_id = ?` |
| 设备列表 / 多端在线状态 | ❌ 无聚合 | 关系表 + 索引 |
| 互联日志（谁、何时、从哪、何方式） | 弱（追加 JSON） | 事务 + 时间索引 |
| deepc 偏好（结构化） | 弱（整 JSON 读写） | 强类型列 + 部分更新 |
| token 轮换历史 | ❌ | 表 + 时间戳 |
| 数据一致性（多字段原子更新） | ❌ 无事务 | 事务 |

### 3.2 为什么临时口令信令留 KV

| 特性 | KV 优势 | D1 劣势 |
|------|---------|---------|
| 一次性消费（读后即删） | 原生 `delete` | 需手动 DELETE + 竞态 |
| 短 TTL（60s 自动过期） | 原生 `expirationTtl` | 需定时任务清过期行 |
| 高频键值读写 | 亚毫秒 | 有 SQL 开销 + 连接池 |
| 密文透传（无需查询语义） | 完美契合 | 大材小用 |

> **结论**：KV 与 D1 是**互补分工**，不是替代关系。信令「一次性 + 短 TTL + 无查询」是 KV
> 的最优场景；用户/会话「关系型 + 聚合 + 事务」是 D1 的最优场景。

## 4. 迁移方案设计

### 4.1 D1 表结构（草案）

```sql
-- 用户（GitHub OAuth 唯一来源）
CREATE TABLE users (
  github_id   INTEGER PRIMARY KEY,      -- GitHub 数字 id
  login       TEXT NOT NULL,
  email       TEXT,
  avatar_url  TEXT,
  name        TEXT,
  bio         TEXT,
  html_url    TEXT,
  followers   INTEGER DEFAULT 0,
  following   INTEGER DEFAULT 0,
  public_repos INTEGER DEFAULT 0,
  token_enc   TEXT NOT NULL,            -- AES-GCM 加密 token
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 会话（支持多端，可续）
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,         -- 随机 UUID（cookie 引用）
  github_id   INTEGER NOT NULL REFERENCES users(github_id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX idx_sessions_github ON sessions(github_id);

-- deepc 偏好（用户级，账户档案直接用 GitHub，这里只管 deepc 自身偏好）
CREATE TABLE deepc_preferences (
  github_id           INTEGER PRIMARY KEY REFERENCES users(github_id),
  theme               TEXT,                -- deepc 主题偏好（JSON 字符串，非敏感）
  encryption_key_enc  TEXT,                -- 自定义端到端加密 key（AES-GCM 密文，绝不存明文）
  updated_at          INTEGER NOT NULL
);

-- 互联日志（谁、何时、以何种方式连过本机 dsh）
CREATE TABLE interconnect_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id   INTEGER,                    -- 可空：未登录临时口令连接不绑定账号
  event       TEXT NOT NULL,              -- connect / disconnect / passphrase_link / multi_device_link
  detail      TEXT,                       -- 连接详情（roomId 哈希、方式、结果，不存明文口令）
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_log_github ON interconnect_log(github_id, created_at);
```

### 4.2 迁移路径（分阶段，KV 不立即弃用）

| 阶段 | 内容 | KV 状态 |
|------|------|---------|
| **P1 并行写入** | D1 建表；callback 同时写 KV + D1（双写），读优先 D1、回退 KV | 保留（过渡） |
| **P2 读切换** | `/auth/me`、`/auth/logout` 改读 D1；`session`/`user` 不再写 KV | `session`/`user` 冻结 |
| **P3 清理** | 删除 KV `session:*`/`user:*`；仅保留 `state:*` + `signal:*` | 只剩 state + signal |
| **P4 加固** | 互联日志接入、限流中间件落地（profile 直接用 GitHub，无独立 profile 页） | 不变 |

- **降级策略**：P1 双写期间任一后端故障可回退，零停机。
- **wrangler 配置**：新增 `[[d1_databases]]` 绑定 `DEEPSEA_D1`，保留 `DEEPSEA_KV`。

### 4.3 限流状态存储

| 限流 | 存储 | 键/表 | TTL/窗口 |
|------|------|-------|----------|
| 错误限流（60min/5 次） | KV | `ratelimit:{ip}:signal-err` | 60min 滑动窗口 |
| 频次限流（≤5 req/s） | KV 或内存 | `ratelimit:{ip}:req` | 1s 窗口 |

- 限流状态本质是「短期计数 + 自动过期」，KV 契合（`expirationTtl`）。D1 用表 + 定时清理
  反而复杂，**限流留 KV**。

## 5. 两个互联方案（登录后多端直连 + 临时口令分享）

> 这是「多端互联」的产品形态拆解，两条链路并存、互补，共用同一 WebRTC 数据面。

### 5.1 方案 A：登录后多端直接互联（无口令，账户绑定）

```
设备 A（已登录 GitHub 账号 X）  ──►  设备 B（已登录 GitHub 账号 X）
   │  /auth/me 得 githubId=1234          │  /auth/me 得 githubId=1234
   │  信令：roomId = HKDF(账号X标识)       │
   └─── 同一账号 → 自动发现 → 直连 ─────────┘
```

- **身份来源**：GitHub OAuth 登录态（`githubId`），无需口令。
- **信令寻址**：同一账号多设备共享一个派生 roomId（`HKDF("account:" + githubId)`），
  Worker 依据「两端是否携带同一账号的会话 cookie」放行信令读写。
- **适用**：用户自己的多设备（桌面/移动/远程浏览器）无感互连，是「登录自然无感」的核心体验。
- **安全**：账号即授权，无需口令；但需「多端在线状态 + 设备管理」（D1 支撑）。

### 5.2 方案 B：临时口令分享连接（跨账号/未登录，60s）

``` 
host（dsh 前端，可不登录）  ── 生成 8 位临时口令(60s) ──►  client（/sonar，可登录/未登录）
   │  roomId = HKDF(口令)                                    │  roomId = HKDF(口令)
   └─── KV 信令（一次性消费 + 60s TTL）──► 输入口令 ──────────┘
```

- **身份来源**：临时口令本身（不依赖登录态），用于「分享给他人」场景。
- **适用**：跨账号、临时授权他人远程访问本机 dsh。
- **安全**：8 位 + 60s + 错误限流（60min/5 次）+ 频次限流（≤5 req/s）四重防护。
- **静态壳承载**：多端互联的 chatUI 由 deepc 主站自实现（不再寄生官方快照），
  工程同步与多端互联共用同一 `deepc-sonar-bridge` RTC 通道，详见
  `deepsea-deepc-bridge-plan.md`。

### 5.3 两方案对比与协作

| 维度 | A 多端直连 | B 临时口令分享 |
|------|-----------|---------------|
| 身份 | GitHub 账号 | 8 位口令（60s） |
| 目标 | 自己的多设备 | 他人临时访问 |
| 信令 | D1 账号 roomId | KV 临时口令 roomId |
| 登录要求 | 两端都登录同账号 | host 可不登录 |
| 持久性 | 长（多端状态在 D1） | 短（60s 一次性） |
| 静态壳 | 可复用同一子域名 | deepc 主站自实现 chatUI |

- **协作**：方案 A 是「留存 + 粘滞」的主力（登录无感）；方案 B 是「分享 + 轻量接入」的补充。
  两者共用 `deepc-peer` 的 DataChannel 数据面，仅「身份 → roomId」的派生与授权方式不同。
  账户档案直接用 GitHub（不重复存储），deepc 自身偏好（主题/自定义加密 key/互联日志）
  存 D1 的 `deepc_preferences` / `interconnect_log`（见 §4.1）。

## 6. deepc 偏好管理（替代 profile 页，账户档案直接用 GitHub）

> 账户档案（头像/昵称/简介/仓库数）**直接用 GitHub 的**，不重复存储、不建独立 profile 页。
> deepSea 侧只管理「deepc 自身偏好」，落 D1 的 `deepc_preferences` 表。

| 偏好项 | 默认 | 说明 | 落库 | 敏感性 |
|--------|------|------|------|--------|
| 主题偏好 `theme` | 空 | deepc 主题偏好（JSON 字符串） | `deepc_preferences.theme` | 非敏感（明文） |
| 自定义加密 key `encryption_key_enc` | 空 | 用户自定义端到端加密 key | `deepc_preferences.encryption_key_enc` | **敏感（AES-GCM 密文，绝不存明文）** |
| 互联日志 | — | 谁/何时/以何种方式连过本机 dsh | `interconnect_log` | 敏感（仅本人可见，`detail` 只存 roomId 哈希） |

- **访问方式**：`/auth/preferences`（GET/PUT，加密 key 前端传明文 → Worker 加密落库 → 读时解密）
  + `/auth/interconnect-log`（GET，限登录用户查自己日志）。见 `apps/worker/src/auth/preferences.ts`。
- **授权范围**：deepc 偏好仅影响「deepc 自身体验」（主题/加密），不触碰 GitHub token 权限
  （token 只用于 discussions/公开仓库，scope 固定 `read:user public_repo`）。
- **行为边界**：加密 key 是「数据加密」，不是「连接授权」——连接授权仍由临时口令（B）或
  账号（A）承载；key 落库为密文，Worker/Cloudflare 均不可读明文。

## 7. KV 优化（继续服务临时口令信令）

KV 迁移后只剩 `state:*` 与 `signal:*`，优化项：

1. **signal TTL 收敛**：`signalTtl` 默认 24h → **60s**（对齐临时口令有效期），
   同步修正 `index.ts` Env 注释（现写「默认 15 分钟」，与 `kv.ts` 实现不一致）。
2. **一次性消费保留**：`get` 读后即删不变（KV 原子删除）。
3. **信令键前缀**：保持 `signal:{roomId}:{kind}` 不变（roomId 已哈希，Worker 不见明文口令）。
4. **限流键**：`ratelimit:{ip}:*` 新增，短 TTL（60min / 1s 窗口）。

## 8. 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| D1 迁移期间双写不一致 | 中 | P1 双写 + 读优先 D1、回退 KV；迁移脚本幂等 |
| D1 冷启动/连接开销 | 低 | D1 对低频 auth 足够；token 校验走 GitHub 而非 D1 热路径 |
| 限流误伤正常用户 | 中 | 错误限流按 IP 而非账号；封禁返回明确 retryAfter 提示 |
| 多端直连账号 roomId 可被同账号恶意设备劫持 | 中 | 需「设备注册 + 会话校验」；D1 记录设备，异常可下线 |
| 临时口令暴力遍历 | 低 | 8 位 + 60s + 错误限流三重防护 |

## 9. 结论与建议

1. **采纳**：用户/会话/deepc 偏好/互联日志迁 D1；KV 只留 `state` + 临时口令信令 + 限流计数。
2. **采纳**：两个互联方案并存——A「登录后多端直连」做留存，B「临时口令分享」做轻量接入。
3. **采纳**：临时口令收敛为 8 位 + 60s（改 `generatePairCode(8)`、`signalTtl=60`、host 面板倒计时）。
4. **采纳**：双层限流——错误限流（60min/5 次）+ 频次限流（≤5 req/s），状态存 KV。
5. **已落地**：`use-auth.ts` 的 `/auth/me` 并发去重（in-flight 单例）已实现。
6. **已落地**：D1 建表 + 双写迁移（P1）+ preferences/互联日志端点已完成；P2 读切换待推进。
7. **已废弃（原 Plan C）**：子域名 `sonar-landing-page.deepc.cn` 承载快照静态壳的方案已随
   寄生快照一并废弃，多端互联改为自实现 chatUI，见 `deepsea-deepc-bridge-plan.md`。

## 10. 待确认问题

- [ ] D1 迁移是否需保留 KV 的 `user:*`/`session:*` 历史数据回填？（影响 P1 双写范围）
- [ ] 多端直连的「设备注册」模型：是否引入设备 ID + 重命名/下线？（决定 sessions 表粒度）
- [ ] 自定义加密 key 的生成策略：用户手动设置 vs 首次登录自动派生？是否支持轮换/找回？
- [ ] 限流封禁是否需要在 KV 之外提供「人工解封」入口？
- [ ] 子域名方案（原 Plan C）已废弃；新的工程同步 + 多端互联触发与粒度待定（见
      `deepsea-deepc-bridge-plan.md` §9 疑点清单）。
