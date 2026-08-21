# deepc-bridge 配置同步 + 存储偏向评估

> 状态：**已实现（D1 权威 + DO 推送 config-changed）** · 关联 `deepsea-deepc-bridge-plan.md`（总体）、
> `deepsea-deepc-bridge-roadmap.md`（执行）、`deepsea-deepc-bridge-signaling.md`（多端设备）
> 本文档承载两项关键决策：①「工程同步」收敛为「配置同步 + session 迁移」；
> ② D1/KV 存储偏向（在不突破 Cloudflare 免费额度前提下的数据落点设计）。
> 注：曾短暂迁 gist（PDCA-G4），后因 WS+DO 就位迁回 D1；§3.2 的加速通道已由
> 「信箱信令 nodeSignal」升级为「DO 推送 config-changed」（零轮询）。

---

## 1. 定位修正：工程同步 → 配置同步（+ session 迁移）

原方案（plan.md §6）把「工程同步」定义为「工作区目录 + 聊天记录」全量/增量实时同步。
经推敲，此定义有两个硬伤：

| 硬伤 | 说明 |
|------|------|
| **工作区不具跨端同一性** | 每台 Node 的 `cwd`、文件树、依赖、环境各异，强制同步工作区 = 制造冲突而非带来一致 |
| **成本与价值错配** | 大体积文件实时传输占用 RTC 带宽 + D1 存储（5GB 上限），但用户真正高频需要的只是「配置一致」 |

**修正后的定位**：

| 能力 | 语义 | 时机 | 数据规模 |
|------|------|------|---------|
| **配置同步**（本期） | deepc 插件自身配置（theme / 模型 / 偏好 / 插件开关）跨端一致 | 登录即同步，改动即广播 | 极小（每项 < 几 KB） |
| **session 迁移**（后续） | 两 Node 都在线时，把某 session 聊天记录从 A 迁到 B | 显式操作（点迁移） | 中等（单 session 若干 KB～MB） |
| ~~工作区同步~~ | ❌ 移除 | — | — |

> 核心原则：**「多端一致」的对象从「工程」收窄到「配置」**；工程数据本身在每台
> Node 本地是权威、不跨端。session 迁移是「显式、点对点、合理范围」的例外，
> 走 RTC 直传不经服务器存储。

---

## 2. 配置同步：数据模型 + 时效优先级 + 冲突处理

### 2.1 数据模型（D1 `deepc_config`）

配置是「账号级、key-value、带来源与版本」，落 D1（理由见 §4）：

```sql
CREATE TABLE IF NOT EXISTS deepc_config (
  github_id  INTEGER NOT NULL,   -- 账号归属
  key        TEXT NOT NULL,      -- 配置键（theme / model / plugin.* / pref.*）
  value      TEXT NOT NULL,      -- JSON 值（明文或按需加密，见 §2.4）
  node_id    TEXT,               -- 来源 Node（null = 主站/用户手改）
  updated_at INTEGER NOT NULL,   -- 权威时间戳（worker 写入，统一时钟）
  PRIMARY KEY (github_id, key)
);
CREATE INDEX IF NOT EXISTS idx_config_github ON deepc_config(github_id, updated_at);
```

### 2.2 时效优先级（last-write-wins + 确定性 tie-break）

- **统一时钟**：`updated_at` 由 **worker** 写入（`Date.now()`），**不信任各 Node 本地
  时钟**（跨端时钟漂移会破坏 LWW）。这是「时效优先级自动处理」的根保证。
- **单调递增**：写时 `updated_at = max(now, 现有 updated_at + 1)`，防止同毫秒并发写
  回退、保证全序。
- **确定性 tie-break**：`updated_at` 相等时按 `node_id` 字典序决胜，保证两端在相同
  输入下收敛到同一结果（无随机性）。

### 2.3 冲突处理

- **key 级粒度**：冲突面收窄到单个配置键，不同键互不干扰。
- **LWW 简化**：首版不做 CRDT，last-write-wins + tie-break 已足够（配置写入是
  「低并发、用户主导」场景，非高频协作编辑）。
- **审计/回滚（可选增强）**：`deepc_config_history` 保留最近 N 版（`github_id + key +
  updated_at`），供「谁在何时改了什么」审计与一键回滚。首版可不做。
- **设备删除**：`remove` 设备时**不删除**该设备写入的配置（配置归属账号而非设备）；
  但该设备的 `node_id` 来源标记保留，供审计追溯。

### 2.4 敏感配置加密

部分配置（如 `encryption_key`）属敏感项：复用 `deepc_preferences.encryption_key_enc`
的既有约定——**值经 AES-GCM 加密后落库**，密钥派生自 `TOKEN_ENC_KEY`（Worker 侧），
或端到端加密（Node 本地派生，Worker 只见密文）。首版：非敏感配置明文 + 敏感配置
E2E 加密（不新增密钥体系）。

---

## 3. 同步机制：D1 权威 + RTC 加速

「真正发挥 RTC 多端」与「可靠一致」可兼得，采用**双路**：

### 3.1 权威源 = D1（worker 中转，可靠基线）

```
Node A 改配置 → PUT /auth/config/put（device_token/cookie）
             → worker 写 deepc_config（统一时间戳）
Node B 上线/轮询 → GET /auth/config/list?since={seq}（增量拉取）
```

- **离线可补**：Node 上线即拉全量/增量，不怕错过离线期间变更。
- **写额度充足**：D1 写 10 万行/天（见 §4），配置写频远够。

### 3.2 加速通道 = DO 推送（config-changed，零轮询）

```
Node A 改配置 → 写 D1 + worker 经 DO 信号房广播 config-changed
Node B 收通知（WS） → 拉增量（回源 D1，最终一致性仍以 D1 为准）
```

- **单连接复用**：config-changed 与 offer/answer 信令共用插件端同一 WS 长连接（DO 信号房）。
- **实时性**：配置变更即时推送，而非等轮询周期。
- **最终一致**：DO 推送只是「加速」，数据真相永远在 D1；两端即使 WS 断开，
  也靠 D1 增量拉取（`since` 下推）收敛。

---

## 4. D1 / KV 存储偏向评估

### 4.1 Cloudflare Workers 免费额度（参考值，以官方定价页为准）

| 资源 | 免费额度/天 | 关键结论 |
|------|-----------|---------|
| Workers 请求 | 100,000 | 富余 |
| **KV 读** | 100,000 | 富余 |
| **KV 写** | **1,000** | ⚠️ **稀缺**（100 倍于 D1 写） |
| KV 删除 | 1,000 | 稀缺 |
| KV 存储 | 1 GB | 中等 |
| **D1 行读** | 5,000,000 | 富余 |
| **D1 行写** | **100,000** | 相对充裕（是 KV 写 100 倍） |
| D1 存储 | 5 GB | 中等（够配置，不够聊天记录全文） |

> 官方参考：https://developers.cloudflare.com/workers/platform/pricing/
> 与 https://developers.cloudflare.com/d1/platform/pricing/

### 4.2 决策原则

**一句话：一次性 + 短 TTL + 低写频 → KV；持久 + 需查询/排序 + 高频写 → D1；大体积 →
RTC 直传（D1 只存索引）。**

### 4.3 数据落点总表（存储偏向决策）

| 数据类型 | 落点 | 写频 | 决策依据 |
|---------|------|------|---------|
| **配置**（theme/model/偏好） | **D1 `deepc_config`** | 中 | 持久 + 按 key 查 + 写额度 100× |
| **信令**（offer/answer/config-changed） | **WS+DO 推送（不落 KV）** | 高 | 实时推送零轮询，无 KV 写消耗 |
| OAuth state / session / deviceGrant | KV | 低 | 一次性 + 短 TTL |
| 限流计数 | 内存 + KV（仅口令错误时） | 极低 | 已实现（频次走内存，错误才写 KV） |
| 用户/会话/设备/令牌/日志 | D1 | 低～中 | 关系型 + 持久 + 审计 |
| **session 聊天记录** | **RTC 直传 + D1 索引** | — | 大体积不经服务器存储（护 5GB） |

### 4.4 KV 写预算（关键风险点）

KV 写 1000/天是**全站最紧的约束**。当前 KV 写来源全为「一次性短 TTL」，写频可控：

| 来源 | 每次成本 | 日预算占比（估算） |
|------|---------|-----------------|
| OAuth state（登录） | 1 写 + 1 删 | 低 |
| session（登录） | 1 写（P1 双写 D1） | 低 |
| deviceGrant | 1 写 + 1 删 | 低 |
| 错误限流 | 仅口令错误时写 | 极低 |

- **配置同步绝不放 KV**（否则高频写直接击穿 1000/天）。
- **信令走 WS+DO 推送（不落 KV）**：彻底消灭信箱信令的 KV 写消耗（A2 已完成）。
- **错误限流已优化**（内存频次 + KV 仅错误时），无需改动。

### 4.5 存储增长护栏

- **D1 5GB**：配置同步数据量小（每项 KB 级），session 迁移只存**索引**不存全文 → 不会
  逼近上限。
- **KV 1GB**：信令 TTL 60s/120s 自动清理，稳态占用极小。
- **后续如需聊天记录云端备份**：再单独评估 R2 对象存储（独立计费），不在本期范围。

---

## 5. 落地顺序（纳入 roadmap）

| 步骤 | 内容 | 前置 |
|------|------|------|
| PDCA-6 | D1 `deepc_config` 表 + `/auth/config/list|put` 端点（cookie + device_token） | D1 迁移 |
| PDCA-7 | 插件端配置读写 + 登录后拉全量 + 改动写回（LWW 时间戳） | PDCA-6 |
| PDCA-8 | 配置变更广播（信箱信令通知 + 增量拉取） | PDCA-7 + PDCA-5 信箱信令 |
| PDCA-9 | session 迁移（RTC 直传 + D1 索引，后续） | 可靠分包底座 |

---

## 6. 参考

- 总体：`docs/deepsea-deepc-bridge-plan.md`（§6 待修订为「配置同步 + session 迁移」）
- 多端设备/信箱信令：`docs/deepsea-deepc-bridge-signaling.md`（§2.2 信箱式信令）
- 执行：`docs/deepsea-deepc-bridge-roadmap.md`
- 存储/Auth：`docs/deepsea-auth-migration-evaluation.md`
