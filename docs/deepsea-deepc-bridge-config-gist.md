# deepc-bridge 配置 gist 化 + 临时连接移除 + D1 精简

> 状态：**决策 1/3 已回退（2026-08-21）** · 决策 2「移除临时连接」✅ 保留 · 关联 `deepsea-deepc-bridge-plan.md`、`deepsea-deepc-bridge-roadmap.md`
> 回退说明：WS+DO 信号房贯通后，配置改回 D1 存储 + DO 推送 config-changed（自动同步，零轮询），
> gist 备份/还原方案（决策 1）与 D1 精简（决策 3）整体撤销。详见 memory「配置迁回 D1 + DO 推送 config-changed」。
> 决策日期：2026-08-21 · 依据用户三项方向性调整定稿（其中 1/3 已回退）。

---

## 1. 三项决策（已拍板）

| # | 决策 | 结论 |
|---|------|------|
| 1 | 配置备份改用 GitHub Gist | **Device Grant 下发 GitHub token，插件端直调 gist**（方案 A） |
| 2 | 临时连接 | **立即移除**（connectId + `/auth/signal/*` + 临时互联开关 + link code） |
| 3 | D1 迁移 | `deepc_config` + `deepc_preferences` → gist；仅留**状态/身份/安全审计**类；审计 30 天自动清除 + 事件字典表 |

---

## 2. 配置备份 gist 化（决策 1）

### 2.1 核心矛盾与解法

插件端（127.0.0.1:3080）无 GitHub token。解法：**Device Grant 授权后，插件端用
device_token 调 `/auth/me` 换取 GitHub token**（复用现有 me 端点，device 分支返回解密后的
token），token 落插件端 localStorage，供 gist REST 直调。

> 安全边界（用户已确认）：配置内容用**用户自设的「远端加密密钥」E2E 加密**，因此即使
> gist 或 token 泄露，配置仍为密文。OAuth scope 最小化到 `gist`（+ 既有 read:user/public_repo）。

### 2.2 OAuth scope

`DEFAULT_OAUTH_SCOPE` 与 `GITHUB_OAUTH_SCOPE` 增加 `gist`：
`read:user public_repo gist`。已授权用户需 reauthorize 才获 gist 权限。

### 2.3 数据流

```
「配置备份」：插件端收集本地配置 → 输入远端密钥 → HKDF 派生 AES-GCM 密钥
            → 加密配置 JSON → gist.create（description=`deepc-config-{timestamp}`，内容=密文）
「云端还原」：列出 `deepc-config-*` gists → 选一个 → 输入密钥 → 读内容 → 解密 → 应用本地
```

### 2.4 gist 交互（插件端原生 fetch，符合「前端直调 GitHub」精神）

- 列表：`GET /gists`（过滤 description 前缀 `deepc-config-`）
- 创建：`POST /gists` `{ description, public:false, files:{ "deepc-config.json": { content } } }`
- 读取：`GET /gists/{id}` → 取 files 内容
- 删除（可选）：`DELETE /gists/{id}`

### 2.5 加密（E2E）

- 密钥 = HKDF(用户输入的远端密钥, salt="deepc-config", info="e2e-encryption") → AES-GCM 256
- 密文格式 `base64(iv + ciphertext)`，gist 只存密文。
- **密钥不落盘、不上传**，仅在备份/还原会话内存中。

---

## 3. 移除临时连接（决策 2）✅ 已完成

删除清单：

| 资产 | 处置 |
|------|------|
| `connectId` 临时互联开关（host-ui.ts） | 删（保留 device 登录 + 邮箱 host） |
| `/auth/signal/*`（worker `auth/signal.ts` + index 路由 + wrangler） | 删 |
| 前端 `lib/deepc-bridge/signaling.ts`（临时口令信令） | 删 |
| `crypto.ts` `generatePairCode` / `deriveRoomId` / `deriveSignalKey`（临时口令派生） | 删（保留 `generateConnectId`=nodeId + `deriveNodeSignalKey`=信箱） |
| `sonar.tsx` link code 输入框 + 确认码弹框 | 删，只留「点卡片直连」 |
| `session.ts` 临时口令 host/client 函数 | 删（保留 mailbox 函数） |

> 保留：信箱式信令（`node-signaling.ts` + `nodeSignal` KV 键），多端直连唯一通道。
> 效果：KV 信令只留 `nodeSignal`（登录态 + 归属校验），无匿名信令面。

### 3.1 实施记录（2026-08-21）

除上表外，连带清理的死代码：

- `worker lib/ratelimit.ts`：删除「错误限流」整块（`checkErrorLimit` / `recordError`，
  专为临时口令暴力猜测设计；信箱信令是登录态 + 归属校验，不需要）。
- `worker lib/kv.ts`：删除 `kvKeys.signal` + `signalTtl`（临时口令专用键/TTL）。
- `worker lib/index.ts`：OPTIONS preflight 内联为本地 CORS 响应（原依赖 signal.ts 的
  `handleSignalOptions`）。
- `poc/host-listen.ts` / `verify-bridge.ts` / `verify-e2e.ts`：删除（临时连接验证脚本，
  不在 tsconfig include 内，保留会误导）。`poc/mailbox-poc.ts` 保留（信箱信令验证）。
- `device-auth.ts` / `host-ui.ts` 的「临时互联」注释同步清理。

> 本次还顺带修了 `/auth/signal/get` 404 的根因：临时连接移除前，插件端旧 bundle 仍会
> 轮询 `/auth/signal/get`，而该端点已随 gist 迁移被判定为遗留。移除后插件端只剩
> `/auth/node/signal/*`（信箱）与 `/auth/device-grant*`（授权）两类调用。

---

## 4. D1 精简（决策 3）

### 4.1 最终 D1 表（保留）

| 表 | 类别 | 理由 |
|----|------|------|
| `users` | 身份 | 登录态关联 |
| `sessions` | 身份 | 会话校验 |
| `deepc_nodes` | 状态 | 设备注册/心跳/在线判定（实时） |
| `deepc_device_tokens` | 状态 | 设备令牌哈希校验（实时） |
| `interconnect_log` | 安全审计 | 安全相关核心事件（精简后） |

### 4.2 移除 ✅ 已完成

- `deepc_config` → gist（决策 1）
- `deepc_preferences` → gist（theme / encryption_key 均迁）
- 对应端点 `/auth/config/*`、`/auth/preferences` 的「非安全」部分

### 4.3 实施记录（2026-08-21，PDCA-G4 ✅）

- **插件端**：`config-sync.ts` 删 D1 交互（`listConfig`/`putConfig`/`syncConfig`/
  `startConfigSync`/`authFetch`），保留本地快照 `collectConfigJson`/`applyConfigJson`/
  `getLocalConfig`/`getConfigSnapshot`（gist 备份/还原的序列化层）；`host-ui.ts` 删
  `startConfigSync` 调用 + `configSync` 变量（停 60s 轮询）。配置权威源 = gist（手动备份/下载）。
- **worker**：删 `auth/config.ts` 整文件；`auth/preferences.ts` 删 theme/encryption_key 部分
  （保留 `handleInterconnectLog`）；`index.ts` 删 config/preferences import + 路由 + `isCorsAuthPath`
  的 config 判断；`wrangler.toml` 删 `/auth/config/*`、`/auth/preferences` 白名单；
  `lib/d1.ts` 删 `DeepcPreferencesRow`/`getPreferences`/`upsertPreferences`/
  `DeepcConfigRow`/`CONFIG_KEY_RE`/`getConfig`/`listConfig`/`putConfig`。
- **migration**：`0005_drop_config_preferences.sql` `DROP TABLE` 两张表（本地已应用 ✅）。
- **效果**：worker 不再承载配置读写 + 配置轮询，只剩 auth（login/callback/me/logout）+
  device-grant + node（注册/心跳/列表/移除/信令）+ interconnect-log（审计）。

### 4.4 审计日志精简

- **只留安全相关核心事件**：`device_auth`（设备授权）、`device_revoke`（设备吊销）、
  `config_backup` / `config_restore`（配置备份/还原，安全敏感操作）、`signal_anomaly`（信令异常）。
- **事件字典表** `audit_event_types`：`code → 说明`，日志表只存 `event_code`（整数/短码），
  避免重复存储长事件名字符串。
- **30 天自动清除**：Worker Cron Trigger（每日）`DELETE FROM interconnect_log
  WHERE created_at < ?`（30 天前）。

---

## 5. 落地顺序（PDCA）

| 循环 | 内容 |
|------|------|
| PDCA-G1 | OAuth scope 加 gist + me.ts device 分支返回 token + 插件端拿 token |
| PDCA-G2 | 插件端 gist 客户端（E2E 加密 + REST）+ host-ui「备份/还原」按钮 |
| PDCA-G3 | 移除临时连接（signal.ts / 前端 signaling / 临时互联开关 / link code）✅ |
| PDCA-G4 | D1 迁移：删 deepc_config + deepc_preferences（迁 gist）✅ |
| PDCA-G5 | 审计精简：事件字典表 + 30 天 Cron 清除 |

---

## 6. 参考

- 总体：`docs/deepsea-deepc-bridge-plan.md`
- 执行：`docs/deepsea-deepc-bridge-roadmap.md`
- 配置同步（旧 D1 方案，将被取代）：`docs/deepsea-deepc-bridge-config-sync.md`
- Auth/D1：`docs/deepsea-auth-migration-evaluation.md`
