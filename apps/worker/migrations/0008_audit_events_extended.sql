-- 审计事件字典扩展（v2：统一规划 + 精简描述）
--   · 新增 web 端用户事件：登录 / 登出 / 销毁账号
--   · 精简描述：去掉括号内实现细节（签发 device_token / 强制轮换安全码 / 硬删 D1 行等），
--     前端按事件码映射 i18n 文案展示，本表仅作服务端兜底说明
--   · detail 语义统一：tunnel_* 相关事件记录「设备名(设备id)」

INSERT OR IGNORE INTO audit_event_types (code, description) VALUES
  ('auth_login',       '登录站点'),
  ('auth_logout',      '退出登录'),
  ('account_destroy',  '销毁账号');

UPDATE audit_event_types SET description = '设备授权'           WHERE code = 'device_grant';
UPDATE audit_event_types SET description = '隧道上线/更新'      WHERE code = 'tunnel_report';
UPDATE audit_event_types SET description = '隧道节点删除'       WHERE code = 'tunnel_delete';
UPDATE audit_event_types SET description = '后台免密直连'       WHERE code = 'tunnel_access';
