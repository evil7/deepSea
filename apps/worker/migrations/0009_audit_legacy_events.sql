-- 审计事件字典补充：旧版遗留事件码（历史日志仍会展示，需可读）
--   device_register 旧 bridge 设备注册 / tunnel_rotate 旧 bridge 安全码轮换
--   新代码不再产生这两类事件；仅作历史日志的服务端兜底说明（前端以 i18n 为准）

INSERT OR IGNORE INTO audit_event_types (code, description) VALUES
  ('device_register', '设备注册'),
  ('tunnel_rotate',   '安全码轮换');
