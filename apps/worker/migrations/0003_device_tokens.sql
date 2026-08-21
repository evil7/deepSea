-- deepc-bridge 设备授权令牌（deepc_device_tokens）
-- 插件端（127.0.0.1:3080）无 deepc 主站 cookie，需独立设备凭证 device_token
-- （Device Grant 授权流签发），用于 register/heartbeat/signal 等 node 端点鉴权。
-- 安全：只存 token 的 SHA-256 哈希（token_hash），不落明文 token——
--   即使 D1 泄露，攻击者也拿不到可直接使用的 token。
-- 生命周期：签发（默认 30 天）→ 校验（未过期）→ 吊销（设备删除 / 账号登出）。
-- 时间戳统一毫秒（Date.now()）。

CREATE TABLE IF NOT EXISTS deepc_device_tokens (
  token_hash TEXT PRIMARY KEY,   -- SHA-256(token) hex（64 字符）
  github_id  INTEGER NOT NULL,   -- 归属账号
  node_id    TEXT,               -- 可选：绑定设备（吊销时按 node 清理）
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devtok_github ON deepc_device_tokens(github_id);
