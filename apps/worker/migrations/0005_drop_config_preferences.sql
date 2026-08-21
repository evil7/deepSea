-- deepc-bridge 配置 gist 化 + D1 精简（决策 3）
-- 配置（deepc_config）与偏好（deepc_preferences）已迁 GitHub Gist
-- （E2E 加密 + 手动备份/还原，全托管），Worker 不再承载配置读写。
-- 故删除这两张表与对应端点 /auth/config/*、/auth/preferences。
-- 保留：users / sessions / interconnect_log / deepc_nodes / deepc_device_tokens。

DROP TABLE IF EXISTS deepc_config;
DROP TABLE IF EXISTS deepc_preferences;
