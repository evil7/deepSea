-- ===========================================================================
-- deepSea D1 完整初始化 schema（单文件汇总版）
--
-- 这是 deepsea D1 数据库的「最终态」DDL，聚合自 migrations/ 下的迁移，
-- 用于：新环境一键建库（wrangler d1 execute deepsea --remote --file=init.sql）、
--       CI 建库、本地从零初始化，避免逐条跑迁移。
--
-- 汇总规则（相对 migration 序列的净效果）：
--   · users / sessions / interconnect_log           ← 0001
--   · deepc_device_tokens                           ← 0002
--   · audit_event_types（含事件字典 seed）           ← 0003
--   · deepc_tunnels（远端互联节点，仅纳管 URL）       ← 0004
--
-- 注：deepc_nodes（设备注册表）/ deepc_config（配置同步）/ deepc_preferences
-- 已随旧 P2P 架构退役删除。新架构（TOTP 2FA + 匿名 Quick Tunnel）只纳管 URL，
-- 见 docs/deepsea-tunnel-bridge-proposal.md。
--
-- 约定：
--   · 用户 id 统一绑定 GitHub 数字 id（users.github_id 主键）
--   · 时间戳统一毫秒（Date.now()）
--   · 敏感数据（token）AES-GCM 加密后落库，绝不存明文
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
CREATE TABLE IF NOT EXISTS interconnect_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id   INTEGER,
  event       TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_github ON interconnect_log(github_id, created_at);

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

-- ── 审计事件字典表（audit_event_types）──────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_event_types (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT OR IGNORE INTO audit_event_types (code, description) VALUES
  ('device_grant',  '设备授权（签发 device_token）'),
  ('tunnel_report', '隧道上报（插件上报最新 URL）'),
  ('tunnel_delete', '隧道节点删除（硬删 D1 行）');

-- ── 远端互联节点表（deepc_tunnels）──────────────────────────────────────
--   三模式：插件本地 3081（TOTP 2FA）+ 匿名 Quick Tunnel / 自定义域 →
--   登录主站上报最新 URL。主站只纳管 URL，不存任何 secret。
--   防膨胀：node_id PK + upsert 原地改（不新增行）；删除为硬删（DELETE）；
--   modified_at 记录最近修改（上报/改名均刷新）；行存在即在线。
CREATE TABLE IF NOT EXISTS deepc_tunnels (
  node_id      TEXT PRIMARY KEY,     -- 插件端由 hostname 派生的确定性 UUID
  github_id    INTEGER NOT NULL,     -- 归属账号（登录态绑定）
  node_name    TEXT NOT NULL,        -- 节点名称（默认 hostname，可改）
  url          TEXT,                 -- 最近上报的 trycloudflare URL / 自定义域
  status       TEXT NOT NULL DEFAULT 'connected',  -- connected|deleted
  created_at   INTEGER NOT NULL,     -- 首次创建时间
  modified_at  INTEGER NOT NULL      -- 最近修改时间（上报/改名）
);
CREATE INDEX IF NOT EXISTS idx_tunnels_github ON deepc_tunnels(github_id);
