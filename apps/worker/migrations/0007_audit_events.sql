-- 安全审计事件字典表（PDCA-G5）
--   interconnect_log.event 存短码（如 device_grant），本表提供 code → 说明映射，
--   约束合法事件码 + 集中文档化，避免日志表重复存长事件名字符串。
-- 事件码设计（聚焦安全敏感、低频高价值操作；心跳等高频操作不记）：
--   device_grant    设备授权（签发 device_token）
--   device_register 设备注册（新 node 登记）
--   device_revoke   设备吊销（node 移除）
--   config_put      配置写入

CREATE TABLE IF NOT EXISTS audit_event_types (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT OR IGNORE INTO audit_event_types (code, description) VALUES
  ('device_grant',    '设备授权（签发 device_token）'),
  ('device_register', '设备注册（新 node 登记）'),
  ('device_revoke',   '设备吊销（node 移除）'),
  ('config_put',      '配置写入');
