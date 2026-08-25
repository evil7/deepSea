-- deepc-link 远端互联节点表（deepc_tunnels）—— 三模式 · 主站仅纳管 URL
-- 每节点一行（无配额表——Quick Tunnel 匿名免费无限）。
-- 架构（见 docs/deepsea-tunnel-bridge-proposal.md）：
--   插件本地 3081 鉴权代理（TOTP 2FA）+ 匿名 Quick Tunnel / 自定义域 →
--   登录主站后上报最新 URL。主站只纳管 URL，不存任何 secret。
-- 防膨胀设计：upsert 直接修改条目（node_id PK），删除为硬删（DELETE）；
-- modified_at 记录最近修改时间（上报/改名均更新）。
-- 时间戳统一毫秒（Date.now()）。

CREATE TABLE IF NOT EXISTS deepc_tunnels (
  node_id      TEXT PRIMARY KEY,     -- 插件端由 hostname 派生的确定性 UUID
  github_id    INTEGER NOT NULL,     -- 归属账号（登录态绑定）
  node_name    TEXT NOT NULL,        -- 节点名称（默认 hostname，可改）
  url          TEXT,                 -- 最近上报的 trycloudflare URL / 自定义域
  status       TEXT NOT NULL DEFAULT 'connected',  -- connected|deleted（行存在即在线）
  created_at   INTEGER NOT NULL,     -- 首次创建时间（节点生命周期起点）
  modified_at  INTEGER NOT NULL      -- 最近修改时间（上报/改名）
);
CREATE INDEX IF NOT EXISTS idx_tunnels_github ON deepc_tunnels(github_id);
