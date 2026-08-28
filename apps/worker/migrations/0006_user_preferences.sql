-- 用户偏好（跟随账号存储，跨设备同步）
--   blocked_users 存 JSON 数组字符串（如 '["spammer"]'）
--   语言/主题为空串表示「未设置，跟随本地/系统」

CREATE TABLE IF NOT EXISTS user_preferences (
  github_id            INTEGER PRIMARY KEY,
  language             TEXT NOT NULL DEFAULT '',
  theme                TEXT NOT NULL DEFAULT '',
  thumbs_down_threshold INTEGER NOT NULL DEFAULT 0,
  block_mode           TEXT NOT NULL DEFAULT 'collapse',  -- collapse | hide | off
  blocked_users        TEXT NOT NULL DEFAULT '[]',
  updated_at           INTEGER NOT NULL
);
