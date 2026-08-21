-- deepc-bridge 配置同步表（deepc_config）
-- 账号级、key-value、带来源与版本，跨端配置一致性（theme / model / 偏好 / 插件开关）。
-- 落 D1（非 KV）：持久 + 按 key 查询 + 写额度富余（D1 写 10 万行/天 vs KV 写 1000/天）。
-- 时效优先级：last-write-wins + worker 统一时间戳（不信任各 Node 本地时钟）。
--   updated_at 由 worker 写入并单调递增（max(now, 现有+1)），node_id 作 tie-break。
-- 冲突：key 级粒度；不同键互不干扰。
-- 敏感配置：value 由端到端加密（E2E）后落库，worker 只见密文（见 config-sync 文档 §2.4）。
-- 时间戳统一毫秒（Date.now()）。

CREATE TABLE IF NOT EXISTS deepc_config (
  github_id  INTEGER NOT NULL,   -- 账号归属
  key        TEXT NOT NULL,      -- 配置键（theme / model / plugin.* / pref.*）
  value      TEXT NOT NULL,      -- JSON 值（明文或 E2E 密文）
  node_id    TEXT,               -- 来源 Node（null = 主站/用户手改）
  updated_at INTEGER NOT NULL,   -- 权威时间戳（worker 写入）
  PRIMARY KEY (github_id, key)
);
CREATE INDEX IF NOT EXISTS idx_config_github ON deepc_config(github_id, updated_at);
