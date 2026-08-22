-- ===========================================================================
-- deepSea D1 完整初始化 schema（单文件汇总版）
--
-- 这是 deepsea D1 数据库的「最终态」DDL，聚合自 migrations/ 下的 0001~0007，
-- 用于：新环境一键建库（wrangler d1 execute deepsea --remote --file=init.sql）、
--       CI 建库、本地从零初始化，避免逐条跑迁移。
--
-- 汇总规则（相对 migration 序列的净效果）：
--   · users / sessions / interconnect_log           ← 0001
--   · deepc_nodes                                   ← 0002
--   · deepc_device_tokens                           ← 0003
--   · deepc_config                                  ← 0006（0004 建 → 0005 删 → 0006 重建）
--   · audit_event_types（含事件字典 seed）           ← 0007
--   · deepc_preferences                             —— 已删除（0001 建 → 0005 删），不再存在
--
-- 约定：
--   · 用户 id 统一绑定 GitHub 数字 id（users.github_id 主键）
--   · 时间戳统一毫秒（Date.now()）
--   · 敏感数据（token / 加密 key）AES-GCM 加密后落库，绝不存明文
-- ===========================================================================

-- ── 用户（GitHub OAuth 唯一来源；github_id = GitHub 数字 id）──────────────
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

-- ── 会话（支持多端，可续；cookie 引用 id，github_id 关联用户）────────────
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

-- ── 互联日志（谁、何时、以何种方式连过本机 dsh）────────────────────────
--   event：短码（device_grant / device_register / device_revoke / config_put 等），
--   说明映射见 audit_event_types 字典表
CREATE TABLE IF NOT EXISTS interconnect_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id   INTEGER,
  event       TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_github ON interconnect_log(github_id, created_at);

-- ── 多端设备注册表（deepc_nodes）───────────────────────────────────────
--   在线判定：online = DO 内存态（WS socket 存活，权威源）；
--   last_seen 仅作「最后活跃时间」展示，不驱动 online（无 HTTP 心跳）。
CREATE TABLE IF NOT EXISTS deepc_nodes (
  node_id    TEXT PRIMARY KEY,        -- hostname SHA-256 派生 UUID（同主机 = 同 ID）
  github_id  INTEGER NOT NULL,        -- 归属账号（登录态绑定）
  name       TEXT NOT NULL,           -- 本端名称（默认 hostname，可改）
  last_seen  INTEGER,                 -- 最后活跃时间戳（毫秒）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_github ON deepc_nodes(github_id);

-- ── 设备授权令牌（deepc_device_tokens）───────────────────────────────────
--   device_token 只存 SHA-256 哈希（token_hash），不落明文
CREATE TABLE IF NOT EXISTS deepc_device_tokens (
  token_hash TEXT PRIMARY KEY,   -- SHA-256(token) hex（64 字符）
  github_id  INTEGER NOT NULL,   -- 归属账号
  node_id    TEXT,               -- 可选：绑定设备（吊销时按 node 清理）
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devtok_github ON deepc_device_tokens(github_id);

-- ── 配置同步表（deepc_config）───────────────────────────────────────────
--   账号级 key-value + LWW（worker 单调递增时间戳）+ node_id tie-break
CREATE TABLE IF NOT EXISTS deepc_config (
  github_id  INTEGER NOT NULL,   -- 账号归属
  key        TEXT NOT NULL,      -- 配置键（theme / model / plugin.* / pref.*）
  value      TEXT NOT NULL,      -- JSON 值（明文或 E2E 密文）
  node_id    TEXT,               -- 来源 Node（null = 主站/用户手改）
  updated_at INTEGER NOT NULL,   -- 权威时间戳（worker 写入，单调递增）
  PRIMARY KEY (github_id, key)
);
CREATE INDEX IF NOT EXISTS idx_config_github ON deepc_config(github_id, updated_at);

-- ── 审计事件字典表（audit_event_types）──────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_event_types (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT OR IGNORE INTO audit_event_types (code, description) VALUES
  ('device_grant',    '设备授权（签发 device_token）'),
  ('device_register', '设备注册（新 node 登记）'),
  ('device_revoke',   '设备吊销（node 移除）'),
  ('config_put',      '配置写入');
