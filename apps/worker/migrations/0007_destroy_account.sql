-- 账号销毁（软删除，24 小时内可撤回）
--   destroyed_at NULL  = 正常账号
--   destroyed_at 非空  = 已发起销毁（token 已清空、关联数据已删除；保留 users 行
--                       作为 24h 撤回窗口标记，超时由 Cron 物理清理）
-- 撤回：重新走 GitHub OAuth 登录 → callback upsertUser 时清除 destroyed_at

ALTER TABLE users ADD COLUMN destroyed_at INTEGER;
