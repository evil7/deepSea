# deepc-link 远端访问功能核对（2026-08-25）

## 结论速览
经 3081 鉴权代理（TOTP 2FA）+ cloudflared Quick Tunnel 的远端访问链路已打通，
dsh 前端在 trycloudflare 域名下可正常加载与使用核心功能。剩余两个不可用项均为
**dsh 官方有意设计（loopback-only）**，非反代可绕过。

## 本轮关键修复
1. **Origin 403 修复**：dsh 对非本地 Origin 做 CSRF 校验返回 403（POST/WS 全被拒）。
   反代在 `proxyReq` / `proxyReqWs` 事件剥离 `Origin` 头后，上游视为非浏览器请求，
   POST 200 / WS 101 恢复正常。
2. **ECONNRESET 崩溃修复**：http-proxy 在上游拒绝 WS（非 101，走 `res.pipe` 路径）时
   不给源 socket 挂 error handler，客户端断开触发进程级 unhandled `ECONNRESET`，
   连带 dsh 退出。现 `upgrade` 处理器对源 socket 挂 `error` 兜底 `destroy()`。
3. **目录选择器 slot 冲突回退**：自建浏览器内目录浏览 UI register 进
   `directoryFlow` 单席位 slot 时与官方 native picker 同 priority 0 冲突，触发
   "Failed to load plugins"。已回退（见 `deepsea-deepc-directory-picker-slot-conflict.md`）。

## 远端功能核对明细
| 功能 | 结果 | 说明 |
| --- | --- | --- |
| 2FA 鉴权页 | ✅ | 6 位动态码登录，种 `dc_site` cookie 后 302 回原路径 |
| dsh 主 UI 加载 | ✅ | 会话列表 / 工作区树 / 聊天界面正常，无 "Failed to load plugins" |
| 设置面板打开 | ✅ | 导航与面板正常 |
| 通用设置 tab | ✅ | 语言 / 外观 / 繁忙时 Enter 行为正常 |
| 模型 tab | ❌ | `加载提供方目录失败: settings are unavailable in this browser` |
| 插件 tab | ✅ | 插件列表 / 插件配置正常 |
| Agent 预设 tab | ✅ | 标准 / PTC / 极简 / 创造模式预设列表正常 |
| deepSea 悬浮球 | ✅ | 远端单行「时长 MM:SS + 断开 + 本机配置不可见」，2FA 卡隐藏 |
| 新建工作区目录选择 | ⚠️ | native 对话框弹宿主机，远端看不到（已回退替换，见冲突文档） |

## settings loopback-only（模型 tab 失败的根因）
`dsh-client-connection` 的 `ctx.connection.isLoopback` 基于浏览器
`window.location.hostname` 判定（`localhost` / `[::1]` / `127/8`）。远端域名下
`isLoopback=false`，settings 服务进入 "memory" persistence：

```js
// dsh-client-ui-settings/lib/client.js
const mirror = new SettingsDescribeMirror(connection.api, connection.isLoopback ? "host" : "memory");
// SettingsDescribeMirror: persistence === "memory" → status 直接 "unavailable"，load() 空转
```

`llm.providers` 需要 `settings.describe` 的 view（writable/namespaces），view 为 undefined
→ 抛 "settings are unavailable in this browser"。这是 dsh 对模型 API key 等敏感配置的
**loopback-only 安全设计**，浏览器端判断，服务端反代无法改写 `window.location`。

> 插件 tab 走 `dynamicCordisRunner/inventory`、Agent 预设 tab 走 `agentPreset.list`，
> 不依赖 `settings.describe`，故远端可用。

## 待办 / 后续方向
- 目录选择器远端可用：见 `deepsea-deepc-directory-picker-slot-conflict.md` 的候选方案
  （复用官方 browse UI + 挂载 browse 后端，或显式 priority shadow）。
- 模型配置远端可用：需 dsh 官方放宽 settings 的 loopback 限制，或接受该限制
  （远端只读聊天/会话/工作区，模型/预设配置在本地 loopback 完成）。
