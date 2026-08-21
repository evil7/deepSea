-- deepSea D1 初始 schema —— 用户 / 会话 / deepc 偏好 / 互联日志
-- 用户 id 统一绑定 GitHub 数字 id（users.github_id 主键），所有数据以其关联。
-- profile（账户档案）直接用 GitHub 的，不在此重复存储。
-- KV 只保留 state（OAuth 防 CSRF）与 signal（临时口令信令）+ 限流计数。
-- 时间戳统一毫秒（Date.now()）。
-- 敏感数据（token / 自定义加密 key）一律 AES-GCM 加密后落库，绝不存明文。

-- 用户（GitHub OAuth 唯一来源；github_id = GitHub 数字 id，全站统一关联键）
CREATE TABLE IF NOT EXISTS users (
  github_id   INTEGER PRIMARY KEY,
  login       TEXT NOT NULL,
  email       TEXT,
  avatar_url  TEXT,
  name        TEXT,
  bio         TEXT,
  html_url    TEXT,
  followers   INTEGER NOT NULL DEFAULT 0,
  following   INTEGER NOT NULL DEFAULT 0,
  public_repos INTEGER NOT NULL DEFAULT 0,
  token_enc   TEXT NOT NULL,              -- AES-GCM 加密 token（TOKEN_ENC_KEY）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 会话（支持多端，可续；cookie 引用 id，github_id 关联用户）
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  github_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_github ON sessions(github_id);

-- deepc 偏好（用户级，账户档案直接用 GitHub，这里只管 deepc 自身偏好）：
--   theme               —— deepc 主题偏好（JSON 字符串，非敏感，明文）
--   encryption_key_enc  —— 用户自定义端到端加密 key（AES-GCM 加密，绝不存明文）
CREATE TABLE IF NOT EXISTS deepc_preferences (
  github_id           INTEGER PRIMARY KEY,
  theme               TEXT,
  encryption_key_enc  TEXT,
  updated_at          INTEGER NOT NULL
);

-- 互联日志（谁、何时、以何种方式连过本机 dsh）
--   github_id 可空（未登录的临时口令连接不绑定账号）
--   event      —— connect / disconnect / passphrase_link / multi_device_link
--   detail     —— 连接详情（roomId 哈希、方式、结果，不存明文口令）
CREATE TABLE IF NOT EXISTS interconnect_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id   INTEGER,
  event       TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_github ON interconnect_log(github_id, created_at);
