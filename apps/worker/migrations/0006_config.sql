-- deepc-bridge 配置同步表（deepc_config）—— 迁回 D1（WS+DO 方案）
-- 背景：0005 曾将 deepc_config / deepc_preferences 迁 GitHub Gist（手动备份/还原）。
-- 现启用 WS+DO 信号房后，配置改回 D1 存储 + DO 推送 config-changed 通知（零轮询）。
-- 仅恢复 deepc_config（逐 key LWW）；preferences（theme/encryption_key）并入 config 键，不单独建表。
-- 账号级、key-value、带来源与版本，跨端配置一致性（theme / model / 偏好 / 插件开关）。
-- 时效优先级：last-write-wins + worker 单调递增时间戳（不信任各 Node 本地时钟）。
--   updated_at 由 worker 写入并单调递增（max(now, 现有+1)）。
-- 时间戳统一毫秒（Date.now()）。

CREATE TABLE IF NOT EXISTS deepc_config (
  github_id  INTEGER NOT NULL,   -- 账号归属
  key        TEXT NOT NULL,      -- 配置键（theme / model / plugin.* / pref.*）
  value      TEXT NOT NULL,      -- JSON 值
  node_id    TEXT,               -- 来源 Node（null = 主站/用户手改）
  updated_at INTEGER NOT NULL,   -- 权威时间戳（worker 写入，单调递增）
  PRIMARY KEY (github_id, key)
);
CREATE INDEX IF NOT EXISTS idx_config_github ON deepc_config(github_id, updated_at);
