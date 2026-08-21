-- deepc-bridge 多端设备注册表（deepc_nodes）
-- 账号内多端长期互联的数据底座：设备注册 + 心跳续期 + 在线判定。
-- 归属：github_id 绑定登录账号；node_id 为随机 UUID（插件首次启动生成，本地持久化）。
-- 在线判定：last_seen 距今 < 心跳阈值（90s）视为 online，查询时计算，不落布尔值。
-- 时间戳统一毫秒（Date.now()）。

CREATE TABLE IF NOT EXISTS deepc_nodes (
  node_id    TEXT PRIMARY KEY,        -- 随机 UUID
  github_id  INTEGER NOT NULL,        -- 归属账号（登录态绑定）
  name       TEXT NOT NULL,           -- 本端名称（默认 hostname，可改）
  last_seen  INTEGER,                 -- 心跳时间戳（毫秒）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_github ON deepc_nodes(github_id);
