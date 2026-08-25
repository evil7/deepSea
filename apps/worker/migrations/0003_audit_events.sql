-- 安全审计事件字典表
--   interconnect_log.event 存短码，本表提供 code → 说明映射。
-- 事件码（聚焦安全敏感、低频高价值操作；心跳等高频操作不记）：
--   device_grant   设备授权（签发 device_token）
--   tunnel_report  隧道上报（插件上报最新 URL）
--   tunnel_delete  隧道节点删除（硬删 D1 行）

CREATE TABLE IF NOT EXISTS audit_event_types (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT OR IGNORE INTO audit_event_types (code, description) VALUES
  ('device_grant',  '设备授权（签发 device_token）'),
  ('tunnel_report', '隧道上报（插件上报最新 URL）'),
  ('tunnel_delete', '隧道节点删除（硬删 D1 行）');
