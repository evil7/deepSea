# deepc-bridge 执行路线图 —— 任务排序 · 里程碑 · PDCA

> 状态：**执行中** · 关联 `deepsea-deepc-bridge-plan.md`（总体方案）、
> `deepsea-deepc-bridge-signaling.md`（多端设备 + 信令方案）、
> `deepsea-deepc-bridge-config-sync.md`（配置同步 + 存储偏向）
> 本文档是**唯一执行追踪底稿**，承载「三维任务排序 + 里程碑 + PDCA 循环」。

---

## 1. 三维现状盘点

| 维度 | 已完成 ✅ | 待做 |
|------|----------|------|
| **工程** | S1 node-datachannel 底座、esbuild 双端构建、D1 表 + 迁移（nodes/device_tokens/config）、node 端点（register/list/heartbeat/remove）、设备授权端点（device-grant/poll）、信令 WS+DO（方案 A）+ 移除轮询（A2）、节点配额（≤3）、审计事件字典表 + 30 天 Cron（G5） | — |
| **功能** | 操作互联（chatUI + 数据面桥 + hello 握手）、主动登录（Device Grant）、插件端设备注册/心跳、前端授权确认页、配置同步（D1 + DO 推送 config-changed）、chatUI 完整化（composer 工具栏 / 设置页真实读写 / settings 实时同步） | session 迁移 |
| **设计** | deepSea 悬浮球 + 变形 Sheet + 登录头像/登出、SSH 风格设备面板、配置同步 UI、chatUI 对齐官方（composer / 设置 dialog / 消息流） | — |

> 注：**自动发现（L1 回环探测）已暂缓**（2026-08-21 决策）——先聚焦 chatUI 完整性；
> 详见 §4 PDCA-6。session 迁移仍为「后续」（PDCA-9 / M6）。

---

## 2. 任务排序（依赖驱动）

按「前置依赖 → 后续」拓扑排序，每项标归属维度与依赖：

| # | 任务 | 维度 | 依赖 | PDCA |
|---|------|------|------|------|
| 1 | 设备授权流（device-grant 端点 + device_token 鉴权） | 工程 | 已具备 node 端点 | PDCA-1 ✅ |
| 2 | 插件端 device-auth 接入（登录按钮 → state → 轮询换 token） | 功能 | #1 | PDCA-2 ✅ |
| 3 | 前端设备授权确认页 + 连接后「保存节点 + 授权登录」提示 | 功能/设计 | #1 | PDCA-3 ✅ |
| 4 | 插件端设备注册 + 心跳接通（Bearer device_token） | 功能 | #2 | PDCA-4 ✅ |
| 5 | 多端直连信箱信令贯通（offer 投递 → 设备信箱 → answer 寻址） | 功能 | #4 | PDCA-5 ✅ |
| 6 | WebRTC 自动发现（L1 本机回环探测 127.0.0.1:3080） | 功能 | —（独立） | PDCA-6 ⏸️ |
| 7 | 配置同步（D1 `deepc_config` + config 端点 + 插件读写 + LWW + DO 推送） | 功能 | #5 | PDCA-7 ✅（迁回 D1） |
| 8 | 信令传输层改造：WS + DO 推送（方案 A）+ 节点配额（每账号 ≤3）+ 移除轮询 | 工程 | #5 | PDCA-10 ✅（A1+A2） |
| 9 | session 迁移（RTC 直传 + D1 索引，后续） | 功能 | 可靠分包底座 | PDCA-9 |

> 排序核心逻辑：**主动登录（#1–4，已完成）是「多端直连」（#5）的前置**；信令传输层
> 改造（#8）在 #5 信箱信令贯通后，把「轮询」升级为「WS 推送」消灭轮询浪费（A1+A2 已贯通）。
> 配置同步已迁回 D1（WS+DO 推送 config-changed）；审计精简见 PDCA-G5。

---

## 3. 里程碑

| 里程碑 | 内容 | 验收标准 | 状态 |
|--------|------|---------|------|
| **M1** 底座 + 操作互联 | node-datachannel 端点、数据面桥、chatUI | 端到端 unary + 下行事件流 PASS | ✅ |
| **M2** 多端设备管理 | D1 表 + node 端点 + 插件侧栏 + SSH 面板 | typecheck + 浏览器验证 PASS | ✅ |
| **M3** 设备授权 + 主动登录 | device-grant 端点 + 插件端接入 + 前端确认页 + 注册/心跳 | 插件端换 token 并注册、list 可见 online | ✅ |
| **M4** 多端直连贯通 + 自动发现 | 信箱信令全流程 + L1 回环探测 | 同账号 A/B 设备无码自动连接 | ⏳（直连贯通 ✅，自动发现暂缓） |
| **M5** 配置同步 | D1 `deepc_config` + config 端点 + 插件读写 + LWW + DO 推送 | 双端配置改动后收敛一致（推送触发） | ✅（迁回 D1） |
| **M6** session 迁移（后续） | RTC 直传 + D1 索引 | 单 session 迁移 SHA-256 一致 | ⬜ |
| **M7** 信令传输层 WS+DO | DO 信号房 + `/ws/signal` + 插件/主站 WS 客户端 + 节点配额（≤3）+ 移除轮询 | 设备侧无轮询、信令推送贯通、超限拒绝登记 | ✅（A1+A2） |
| **M8** chatUI 完整化（对齐官方） | composer 两行工具栏 / 设置 dialog 真实读写（settings.describe/update）/ 插件清单 / 模型选择 / settings 实时同步 | 与官方 dsh 前端操作一致 | ✅ |

---

## 4. PDCA 循环推进

每个循环严格走 **Plan → Do → Check → Act**：

- **Plan**：方案文档已定义（§2 任务序号对应 signaling.md 章节）。
- **Do**：实现代码（worker / 插件 / 前端）。
- **Check**：`pnpm typecheck` + 构建 + 浏览器/curl 端到端验证。
- **Act**：结论沉淀到 `/memories/repo/`，失败修正方案再循环。

| 循环 | 目标 | 当前状态 |
|------|------|---------|
| PDCA-1 | worker 设备授权端点 + device_token 鉴权 | ✅ |
| PDCA-2 | 插件端 device-auth 接入 | ✅ |
| PDCA-3 | 前端授权确认页 + 保存节点提示 | ✅ |
| PDCA-4 | 插件端注册/心跳接通 | ✅ |
| PDCA-5 | 多端直连信箱信令贯通 | ✅ |
| PDCA-6 | WebRTC 自动发现 | ⏸️ 暂缓（先聚焦 chatUI 完整性） |
| PDCA-7 | 配置同步（D1 + 端点 + 插件读写 + DO 推送） | ✅（迁回 D1） |
| PDCA-9 | session 迁移（后续） | ⬜ |
| PDCA-10 | 信令传输层 WS+DO 改造（方案 A）+ 节点配额限制 + 移除轮询 | ✅（A1+A2） |
| PDCA-11 | chatUI 完整化（composer / 设置页真实读写 / settings 实时同步） | ✅ |
| PDCA-G1~G4 | gist 化 + 移除临时连接 + D1 精简 | ✅（配置已迁回 D1） |
| PDCA-G5 | 审计精简（事件字典表 + 30 天 Cron） | ✅ 已落地 |

---

## 5. 参考

- 总体方案：`docs/deepsea-deepc-bridge-plan.md`（§6 已改为「配置同步 + session 迁移」）
- 配置同步 + 存储偏向：`docs/deepsea-deepc-bridge-config-sync.md`
- 多端设备 + 信令：`docs/deepsea-deepc-bridge-signaling.md`（§6 设备授权、§7 自动发现、§8 保存节点）
- Auth/D1：`docs/deepsea-auth-migration-evaluation.md` · `apps/worker/src/lib/d1.ts`
