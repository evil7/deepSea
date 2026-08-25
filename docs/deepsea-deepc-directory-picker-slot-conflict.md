# deepc-link 远端目录选择器 slot 冲突（已回退，待后续方案）

## 状态
已回退。浏览器端不再 register 浏览器内目录浏览 UI 到 dsh 的 `directoryFlow` slot。
相关实现保留在 `packages/deepc-link/src/client/directory-picker.ts`，暂不被引用。

## 背景
远端访问（经 3081 鉴权代理 / cloudflared 隧道）时，dsh 官方
`dsh-client-ui-directory-picker-native` 的「新建工作区目录选择」走 native OS 对话框，
弹在宿主机显示器上，远端浏览器看不到、选不了路径。

为解决此问题，曾实现浏览器内目录浏览 UI（`directory-picker.ts`），
意图 register 进 `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`
两个 slot，shadow 掉 native occupant。

## 冲突现象
dsh 前端启动报错：

```
Failed to load plugins
@deepseek-ai/dsh-client-ui-directory-picker-native
failed to apply loader entry 9cb7e298 (@deepseek-ai/dsh-client-ui-directory-picker-native):
single slot "conversation.hero.workspace.directoryFlow" already has a registration
at priority 0 (registered by deepc-link) — register at a different priority to shadow it
(lowest renders)
```

## 根因
- dsh 的 `directoryFlow` 是 **single kind** slot（每 cell 仅一个 winner）。
- 官方 `dsh-client-ui-directory-picker-native` 用 `slots.register({ name, inject }, Component)`
  注册，未显式指定 priority → 默认 priority 0。
- 我们的 `registerBrowseDirectoryPicker` 用同样的 API 注册，同样落到 priority 0。
- single slot 同一 priority 下出现第二个 entry → dsh 判定为非法注册，抛错，
  使 native picker 插件 apply 失败（表现为前端 "Failed to load plugins"）。

## 已知限制（当前接受）
- 远端访问时，「新建工作区 → 选择目录」仍走 native OS 对话框，弹在宿主机上，
  远端浏览器无法操作。这是 dsh 官方 native picker 在 bindHost=127.0.0.1 下的固有行为。
- 本地 loopback 访问不受影响（native 对话框可用）。

## 后续方案（候选，需评估 dsh slots priority 机制）
1. **显式指定更低/更高 priority**：dsh slots 支持 `register({ name, inject, priority? })`
   （或 `order?`），single slot 的 shadow 规则是「lowest renders / 动态注册默认更低 priority」。
   需读 `dsh-client-ui-slots` 的 `SlotCore.register` 与 `SlotSpec` 确认字段名与取值方向，
   用官方支持的 priority 覆盖 native occupant，而非同 priority 硬撞。
2. **不动 slot，改走 `/__deepc_api/*` 目录枚举 + 自定义入口**：不 shadow native，
   而是在「新建工作区」流程里由 dsh 的 `pickDirectory`/`listDirectory` RPC 是否可注入替代实现，
   或提供独立的「浏览远端目录」入口按钮（副作用是 UI 不整合，体验割裂）。
3. **复用官方 `dsh-client-ui-directory-picker-browse`**：官方已有浏览器内 DirectoryBrowser
   （680×500 Miller 视图），它 consume 注入的 `listDirectory/createDirectory`（来自
   `ctx.workspaces`，走 dsh host 的 browse 后端）。若让远端 dsh host 也挂载 browse 后端
   （当前 bindHost=127.0.0.1 时官方只挂 native 后端），则可直接复用官方 browse UI，
   无需自建。此路径最「正统」，但要改 dsh host 的 directory-picker-auto 判定。

## 关键参考（dsh 内部源码）
- `@deepseek-ai/dsh-client-runtime/lib/types/client/slots.d.ts`：SlotRegistry / register /
  inject / entriesOfSlot（winner = first live entry per cell in priority order）。
- `@deepseek-ai/dsh-client-ui-directory-picker-native/lib/client.js`：native flow 注册方式。
- `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js`：官方 browse flow
  （consume injected `listDirectory/createDirectory/t`，注册方式与 native 相同）。
- 错误文案来源：`dsh-web-frontend/dist/assets/index-*.js`（前端打包产物）。
