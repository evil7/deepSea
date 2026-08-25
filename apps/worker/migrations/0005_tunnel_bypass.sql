-- deepc-link 主站免密（bypass）：
--   1. deepc_tunnels 加 secret_hash 列 —— sha512(TOTP secret) 单向散列（可选）。
--      免密直连关闭时不附带 → NULL（upsert 会清掉旧散列）。
--      主站不存 secret 明文（20 字节 CSPRNG，彩虹表不可行），TOTP 动态码仍由本地派生。
--   2. 审计字典加 tunnel_access —— 后台免密直连（签发一次性 ticket）。

ALTER TABLE deepc_tunnels ADD COLUMN secret_hash TEXT;

INSERT OR IGNORE INTO audit_event_types (code, description) VALUES
  ('tunnel_access', '后台免密直连（签发一次性 ticket）');
