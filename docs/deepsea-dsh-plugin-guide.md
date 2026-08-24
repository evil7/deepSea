# DSH 插件开发指南（Cordis 架构版）—— 外部权威参考 + deepc-link 对照核对

> 状态：**外部调研参考 · 已对照核对** · 本文档是外部调研的 DSH 插件开发技术汇总的
> **本地落盘版**，作为 deepc-link 对接 dsh 插件生态的持续改进参考。
> 编写：2026-08-24 · 来源：外部 `dsh-plugin-development-guide.md`（Cordis 架构版）
> 关联：`deepsea-cordis-plugin-consensus.md`（我方共识底稿）、`deepsea-deepc-bridge-plan.md`（deepc 方案）

---

> **说明**：下文 §1–§9 为外部指南的**权威原文落盘**（略去目录锚点，保留全部机制与约束）；
> §10 为我方新增的 **deepc-link 对照核对**（对照约束逐条核对我方插件代码，标注偏移与结论）。

---

## 1. 概念与定位：DSH 与 Cordis 的关系

### 1.1 一句话定位

**Cordis 是"元框架"（meta-framework）：它不规定你的业务，只规定"能力如何注册、如何注入、如何被生命周期回收"。** DSH 在 Cordis 之上，用自己的工程惯例把"能力"具体化为两类东西：*组合里的插件行（plugin row）* 与 *进程内动态插件（dynamic plugin）*。二者共享同一个 Cordis Plugin 契约。

### 1.2 术语消歧：三种"插件"

| 名称 | 英文 | 本质 | 生命周期 | 谁来定义 |
| --- | --- | --- | --- | --- |
| **Cordis 插件** | Cordis Plugin | 一个 `function` / `class` / `{ apply }` 对象，用 `ctx` 注册能力 | 由 Fiber 托管，随 Fiber 卸载回收 | 开发者写代码 |
| **组合插件行** | plugin row（`cordis.yml`） | 声明式地"把某个 Cordis 插件挂到某个上下文"的一行配置 | 随 Host 启动 / 随 Session 挂载与卸载 | `agent.cordis.yml` / host 组合 |
| **动态插件** | dynamic Plugin/Package | 运行期用 `cordis_define` 定义、`cordis_run` 激活的临时扩展 | 仅当前进程；重启即失 | 会话内 Agent 通过工具链定义 |

**统一心智模型：三者最终都落到"一个带 `apply(ctx)` 的 Cordis Plugin"。**

> ⚠️ **deepc-link 定位（对照）**：deepc-link 是**组合插件行**——通过 `package.json` 的
> `dsh.bundle`（`cordis.patch.yml`）+ `dsh.client`（`platform: web`）声明，经 `dsh plugin add`
> 安装到 profile。**不是**动态插件，因此 §5.1 的「纯 JS 函数体 / 禁 import / 禁全局假设」
> 约束**不适用**于我方（我方是 npm 包 + esbuild 产物，node 端跑在 Node 进程、client 端是
> 编译 bundle）。

### 1.3 Cordis 是 DSH 的哪些部分

- Cordis 本体是 `cordis`（本部署 fork 为 `@deepseek-ai/cordis`，v4.x，ESM-first）。
- 周边：`plugin-loader`、`plugin-include`、`plugin-group`（`isolate`/group 底层）、`plugin-hmr`、`plugin-timer`、`plugin-logger-console`。
- DSH 的"组合文件"就是 loader 配置产物；`timer`、事件、依赖注入、副作用回收都来自 Cordis 核心。

---

## 2. Cordis 核心架构（本源机制）

### 2.1 Context —— 代理式依赖注入容器

- `new Context()` 创建根容器；`ctx.root` 始终指向它。
- **Context 是一个 Proxy**：普通属性读取都走服务解析器（reflect）。
- 三个派生方法：`ctx.extend(meta)` / `ctx.isolate(name, label?)` / `ctx.intercept(name, config)`。
- 内置服务：`events`、`logger`、`reflect`、`registry`，并 mixin 到 `ctx` 上。

### 2.2 Plugin —— 三种入口形态 + 元数据

```ts
const p1 = (ctx, config) => { /* 函数插件 */ }
class P2 { constructor(ctx, config) { /* 类插件 */ } }
const p3 = { apply(ctx, config) { /* 对象插件 */ } }
```

元数据（`Plugin.Base`）：`name` / `Config`（Standard Schema）/ `inject` / `provide` / `intercept`。

`ctx.inject(deps, callback)` 是 `ctx.plugin({ inject, apply: callback })` 的简写。

### 2.3 Fiber —— 生命周期与 effect

状态机：`PENDING → LOADING → ACTIVE`（失败 `FAILED`）；`ACTIVE → UNLOADING → DISPOSED`。

- `ctx.effect(execute, label?)`：立即执行，返回的 **disposer 按注册逆序**在 Fiber 卸载时执行；disposer 可异步。
- `fiber.dispose()` / `fiber.restart()` / `fiber.update(config)`。
- 在已 dispose 的 Fiber 上注册副作用抛 `CordisError('INACTIVE_EFFECT')`。

### 2.4 Service —— 具名能力

- `class X extends Service { constructor(ctx) { super(ctx, 'x') } }` → 注册 + 随 Fiber 回收。
- 等价手写：`ctx.provide(name, value)` 返回 disposer。
- 扩展协议 symbol：`[Service.init]` / `[Service.check]` / `[Service.invoke]` / `[Service.extend]` / `[Service.config]`。

### 2.5 Events —— 五种派发模式

| 模式 | 行为 | 返回值 |
| --- | --- | --- |
| `emit` | 同步派发，不等 Promise | 忽略 |
| `parallel` | 并发执行并 await 全部 | `Promise<void>` |
| `serial` | 依序 await，直到 bail | 首个 bail 值 |
| `bail` | 同步依序，直到 bail | 首个 bail 值 |
| `waterfall` | 监听器围绕 `next` 组合；不 `return next()` 即否决下游 | 最外层返回值 |

- bail 判定 `isBailed(v)`：仅 `v` 非 `null`/`false`/`undefined` 才算 bail。
- waterfall 的最后一个实参就是 `next`；除非有意否决，必须 `return next()`。

### 2.6 依赖注入契约：`inject` vs `get`

| 读取方式 | 语义 | 适用 |
| --- | --- | --- |
| `inject: ['x']` + `ctx.x` | **硬依赖**：未就绪时停在 `PENDING` | 缺了它就做不了事 |
| `ctx.get('x')` | **软依赖/可选**：立即读，拿不到返回 `undefined`，自行降级 | 有则增强、无则跳过 |

> **铁律**：只声明了 `inject: ['x']` 才允许写 `ctx.x`；能可选就不要 `inject`。
>
> ⚠️ **deepc-link 对照**：`ctx.get('x')` 在运行时就是 `ctx.reflect.get('x')` 的 mixin
> （`ReflectService` 里 `this.mixin('reflect', ['get', ...])`），两者**完全等价**——都是
> `_getImpl(name, strict)` 直读 store、**不校验 inject**、未提供返回 `undefined`。
> 我方代码用 `ctx.reflect.get('apiProxy'|'commands'|'agents'|'pluginInventory')`，与指南
> 「`ctx.get` + 判空」语义一致，**无偏移**。

---

## 3. DSH 的插件分层（叠加的制度）

### 3.1 两个平面：Host 组合 vs Agent 预设

| 平面 | 拥有什么 | 实例数 | 典型行 |
| --- | --- | --- | --- |
| **Host 组合** | 注册表本身、跨会话共享、沙箱与审批栈、模型路由、子代理注册表 | 进程一份 | `sessionPersistence`、`sandbox`、`subagents`、`llm` |
| **Agent 预设** | 一个会话对这些注册表的**贡献**（工具/人设/提示段/压缩策略） | 每会话一份 | `tool-bash`、`tool-jobs`、`tool-goal` |

### 3.2 realm / isolate 规则

**"一行发布了服务的插件，不能在预设里裸放。"** 发布服务的插件在预设里必须 isolate realm 且消费者同组。

### 3.3 动态 Cordis 插件

- **Host 半**：跑 Node 进程（文件/网络/命令/Agent/Session/Host 事件/动态 Tool/JSON 方法）。
- **Client 半**：跑浏览器（主题/布局/Tool 卡片/Slot UI）。
- 通信：`harness.handle(method, handler)` + `host.call(method, args)`（仅无损 JSON）。

### 3.4 生命周期与版本模型（三个 id）

| 标识 | 含义 | 稳定性 |
| --- | --- | --- |
| `pluginId` | 可跨版本演进的插件实例 | 稳定 |
| `packageId` | 不可变代码版本 | 不可变 |
| `pluginRunId` | 一次激活尝试 | 每次不同 |

---

## 4. 总体架构设计指导

### 4.1 决策树一：能力属于哪一层？

```
要新增一个能力？
├─ 必须跨会话共享 / 注册表 / 沙箱 / 审批 / 模型路由 / 子代理后端？ → Host 组合
├─ 只是"这一个会话"的贡献？
│   ├─ 发布服务吗？
│   │   ├─ 是 → 必须 isolate realm 且消费者同组
│   │   └─ 否 → 预设裸放
│   └─ → Agent 预设
└─ 只是本会话临时验证/临时界面，重启无所谓？ → 动态插件（define → run）
```

### 4.2 决策树二：Host 还是 Client？

| 需求 | 平台 | 先查 |
| --- | --- | --- |
| 文件、命令、进程、网络 | Host | `fs`/`shell`/`subprocess`/`pty`/`web` |
| Agent、会话数据、Host 生命周期 | Host | 对应 Service + `Event.listEvents` |
| 注册动态 Tool | Host | `Builtin`（`harness`）+ `Tool.listTools` |
| 页面主题、布局、页面状态 | Client | `Theme.listTokens` + Client Service |
| 设置页 / 侧栏 / 输入区 / 浮层 / Tool 卡片 | Client | `Slots.listSubTree` |
| Host 取数 + Client 展示 | 两者 | Host Service + `harness.handle`；Client Slot + `host.call` |

### 4.3 三张对照表

**表 A：Cordis 概念 → DSH 落点**

| Cordis 概念 | 动态插件里 | 组合里 |
| --- | --- | --- |
| `ctx.provide` | `ctx.provide` / Service | 一行"发布服务" → 须 isolate realm |
| `ctx.inject` | 插件对象 `inject: [...]` | 组合行挂载顺序/等待语义 |
| `ctx.get` | `ctx.get('x')` + 判空 | 消费 host 服务的裸行 |
| `ctx.on` | 随 Fiber 回收 | 事件由服务/工具插件内部处理 |
| Fiber 生命周期 | `stop`/`update`/`undefine` | 会话挂载/卸载、host 启动/关停 |

**表 B：读服务 / 写副作用 / 通信 的合法姿势**

| 诉求 | 合法 | 非法 |
| --- | --- | --- |
| 读可选服务 | `ctx.get('x')` + 判空 | 未声明就 `ctx.x` |
| 硬依赖 | `inject:['x']` + `ctx.x` | 用 `inject` 只为省判空 |
| 定时 | `inject:['timer']` + `ctx.timeout/interval` | 裸 `setTimeout` |
| 监听事件 | `ctx.on('e', fn)` | waterfall 不 `return next()` |
| 注册 UI | `ctx.get('slots')` → `slots.inject` → `slots.register` | `apply` 返回 React 元素 |
| Client→Host | `harness.handle` + `host.call` | 注册公开 Remote / `ctx.remote` |

**表 C：动态插件工具语义**

| 工具 | 语义 | 别用来 |
| --- | --- | --- |
| `cordis_inspect_list/query` | 只读查契约 | 当业务服务调用 |
| `cordis_inspect_self` | 读插件/版本/源码/诊断 | 改/启插件 |
| `cordis_define` | 定义不可变 Package | 期望它执行 apply/审批 |
| `cordis_run` | 激活 Package（run/update） | 用 run 隐式切版本 |
| `cordis_stop` | 暂停效果，保留版本 | 当永久删除 |
| `cordis_undefine` | 永久删除插件及 Package | 还需回滚时调用 |

---

## 5. 开发规范与行为约束（硬约束清单）

### 5.1 语言与运行环境

- 动态插件的 `code.host`/`code.client` 是**纯 JavaScript 函数体**，不被 TS/JSX/bundler 转译。
- **禁用**：`import`、`require`、TS 类型、`as`、装饰器、JSX。
- **不要假设**存在 `process`、`Buffer`、`window`、`document`、`fetch`、原生定时器等全局。
- Client React 必须 `React.createElement(...)`。

### 5.2 依赖访问

- 可选服务一律 `ctx.get(name)` 并处理 `undefined`。
- 只在真正硬依赖时 `inject`，且注入后**只**通过 `ctx.name` 访问。
- 用服务/事件/Slot 前先 `cordis_inspect_query` 拿确切签名，**不要凭名字猜 API**。

### 5.3 副作用与生命周期

- 服务、事件、工具、处理器、定时器、Slot、样式、主题覆写**必须属于当前 Fiber**。
- 用 `ctx.effect()` / `ctx.on()` / 返回 disposer 的官方 API；保留 disposer。
- 禁止在 `apply` 外、模块顶层、`window`/`document.body` 上造进程级/页面级副作用。
- 定时器是名为 `timer` 的 Service，用前 `inject: ['timer']`。
- waterfall 监听器除非有意否决，必须 `return next()`。

### 5.4 数据边界

- Service 实例、Event 载荷、Slot props、Session、会话快照、Tool 状态是**内部活数据**。
- **禁止**：`JSON.stringify` / `structuredClone`、递归枚举、整份拷贝、整对象展示。
- 只读任务所需叶子字段，抽出最小 scalar 后再构造**自有** JSON。

### 5.5 通信

- Host↔Client 只走 `harness.handle` / `host.call`；参数与返回值必须无损 JSON。
- 不传函数、React 元素、类实例、Context、Service 等运行期对象过界；不注册公开 Remote 服务。

### 5.6 权限与审批

- Client Package 未经授权 `cordis_run` 返回 `awaiting-approval`（等待决策，不是失败，不要轮询）。
- 用户拒绝后不要再次请求审批；技术失败修同一 plugin 并重试。
- `starting` 表示已进入异步流程，**不等于成功**。

---

## 6. 标准开发工作流

### 6.1 动态插件（七步）

1. `cordis_inspect_list` → 拿 Provider 与方法 schema。
2. `cordis_inspect_query` 读确切契约。
3. 新插件设计首个 Package；改旧插件先 `cordis_inspect_self`。
4. 写纯 JS 到 `code.host`/`code.client`，`cordis_define`。
5. `cordis_run`。
6. 审批/等待/失败，从 Run 卡片、steering 或 `cordis_inspect_self` 取结果。
7. `cordis_stop`；确无需要才 `cordis_undefine`。

### 6.2 组合编辑

1. 用 roster 的 `list()`/`resolve()` 定位预设真实路径。
2. 从副本起步：`copy(from, id, name)`。
3. 写 `preset.yml`，再逐行编辑 `agent.cordis.yml`，守住平面规则与 realm 规则。
4. 挂载校验：`standingKeyFor(id)`。
5. 让用户开真实会话确认工具列表。

### 6.3 版本更新与回滚

| 当前状态 | 目标 | mode |
| --- | --- | --- |
| 无 current | 任一 Package | `run` |
| 有 current | 同一 Package | `run` |
| 有 current | 另一 Package | `update` |
| 更新失败 | `nextPackageId` | `update`（重试） |
| 更新失败 | `currentPackageId` | `run`（回滚） |

---

## 7. 反模式与故障排查

**反模式（不要做）**

1. `ctx.x` 未声明 `inject` → Guard 拒绝。
2. `apply()` 返回 React 元素当作插件结果。
3. 用 `setTimeout` / 未注入 `timer` 就 `ctx.timeout`。
4. waterfall 里不 `return next()`。
5. `JSON.stringify` 一个 Session / 快照 / Service。
6. 在模块顶层 `window`/`document` 上挂副作用，停用后残留。
7. 用 Inspect 查询结果当业务数据。
8. 在预设里裸放"发布服务"的行。
9. 为省一个 `undefined` 判断而滥用 `inject`。

**故障速查**

| 失败 | 先查 |
| --- | --- |
| `service "x" is not declared` | 未声明 `inject` 就用 `ctx.x`；改 `ctx.get`+判空 |
| `cannot get property "timer" without inject` | 查询 timer 服务并 `inject: ['timer']` |
| Client 解析失败 | 是否 JSX/TS/`import`/不可用全局 |
| Slot 注册失败 | 是否查了实时子树、Slot 存在、selector 满足返回协议 |
| UI 加载但页面报错 | 查 `client-render` 诊断与栈 |
| `host.call` 失败 | handler 名、`pluginRunId`、JSON 实参、handler 内依赖 |
| 更新失败 | 保 current/next 语义；修 next 后 update，或 run current 回滚 |

---

## 8. 术语速查表

| 术语 | 定义 |
| --- | --- |
| Context | 代理式依赖注入容器；属性读走服务解析器 |
| Plugin | `function`/`class`/`{apply}` 入口 + 元数据 |
| Fiber | 一次插件应用的运行时实例；托管副作用与回收 |
| Service | 经 `provide`/`Service` 注册的具名能力，随 Fiber 回收 |
| effect | `ctx.effect()` 登记的副作用，卸载时逆序执行 disposer |
| inject vs get | 硬依赖（等待/重载）vs 软依赖（可选/降级） |
| isolate / intercept / extend | 作用域隔离 / 配置拦截 / 元数据派生 |
| Host 组合 | 进程级注册表与跨会话共享能力 |
| Agent 预设 | 单会话贡献 |
| realm（isolate group） | 预设内发布服务时的私有作用域包装 |
| pluginId / packageId / pluginRunId | 插件实例 / 不可变版本 / 一次激活 |
| Host / Client | Node 进程侧 / 浏览器页面侧 |
| `harness.handle` / `host.call` | 动态插件的包私有 Client→Host JSON RPC |

---

## 9. 参考来源

- Cordis Primer（中英）：`docs/cordis-primer.zh.md` / `docs/cordis-primer.md`
- Plugins and lifecycle：`docs/user/develop/framework/index.md`
- Tutorial：Lifecycle and effects / Services：`docs/cordis-tutorial/02-*.md`、`03-*.md`
- `@deepseek-ai/cordis`：<https://www.npmjs.com/package/@deepseek-ai/cordis>
- 动态插件能力契约：`cordis_inspect_list` / `cordis_inspect_query`（运行期实查）
- 内置 skill：`cordis-plugin-development`、`editing-cordis-compositions`

---

## 10. deepc-link 对照核对（2026-08-24）

> 本节对照 §5 硬约束逐条核对我方 `packages/deepc-link` 代码，标注 ✅ 合规 / ⚠️ 合理偏差 / ❌ 偏移。
> 结论依据：直接读 `@deepseek-ai/cordis/src/{context,reflect,registry}.ts` 与 `dsh-host-apiproxy` 源码。

### 10.1 逐条核对

| # | 约束（§5） | deepc-link 现状 | 结论 |
| --- | --- | --- | --- |
| 1 | 插件形态（函数/类/对象） | `index.ts` 函数形态 `export const name` + `export const inject` + `export function apply(ctx)` | ✅ |
| 2 | 硬依赖 `inject` + `ctx.x` | `inject: ['webServer', 'apiProxy']`；`ctx.webServer` 与 `ctx.apiProxy` 均为硬依赖属性访问 | ✅ |
| 3 | 软依赖 `ctx.get` + 判空 | `commands`/`agents`/`pluginInventory` 经 `ctx.reflect.get`（≡ `ctx.get`，源码确认 mixin），`deepc-api.ts` 判空降级 | ✅ |
| 4 | 副作用归 Fiber（`ctx.effect`） | `/deepc` 路由 `ctx.effect(() => ctx.webServer.register(...))`；host 清理 `ctx.effect(() => () => host.dispose())` | ✅ |
| 5 | 禁止模块顶层进程级副作用 | `index.ts` 顶层 `installRtcPolyfill()` 注入 `globalThis.RTCPeerConnection` 等 | ⚠️ 合理偏差（见 10.2） |
| 6 | 定时器用 `timer` Service | node 端用 Node 原生 `setTimeout`/`setInterval`（非动态插件纯 JS，Node 全局合法） | ✅ 适用性说明（见 10.3） |
| 7 | 数据边界（禁 stringify live 对象） | 数据面桥序列化的是 `apiProxy` 返回的**契约值**（`RpcResult<T>` 的 schema-validated view）与官方 `MuxFrame`/`HostFrame`，非 live Service/Session | ✅ |
| 8 | Host↔Client 走 `harness.handle`/`host.call` | client↔node 走 `ctx.webServer.register('/deepc')` + `fetch` | ✅ 适用性说明（见 10.4） |
| 9 | 不注册公开 Remote / 不 `ctx.remote` | 无 `ctx.remote` 使用；无公开 Remote 服务注册 | ✅ |

### 10.2 ⚠️ 模块级 polyfill 副作用（合理偏差）

`index.ts` 第 24 行 `installRtcPolyfill()` 在**模块顶层**执行，向 `globalThis` 注入
`RTCPeerConnection`/`RTCDataChannel`/`RTCSessionDescription`/`RTCIceCandidate`（`node-datachannel/polyfill`），
且无 disposer 撤销。

- **为何是必要偏差**：`session.ts` 复用浏览器风格 WebRTC 代码（裸引用 `RTCPeerConnection`），
  必须在 `session.ts` 任何会话 API 调用前就绪；`node-datachannel/polyfill` 官方即 import-即注入模式。
- **为何可接受**：幂等（`??=`，不覆盖已有全局）；node 端插件随 Host 进程存续，非动态插件
  「停用即清场」语义；注入的是无状态 WebRTC 类，非业务副作用。
- **改进方向（可选）**：若未来要求严格 Fiber 归属性，可改为在 `apply` 内首次连接前惰性
  `installRtcPolyfill()` + `ctx.effect` 记录「是否为本插件首次注入」以在 dispose 时恢复。

### 10.3 ✅ 定时器适用性说明

指南 §5.3「定时器用 `timer` Service」针对**动态插件的 `code.host` 纯 JS 函数体**（其中无
`setTimeout` 全局）。deepc-link 是**组合插件行**（npm 包），node 端跑在 Node 进程，`setTimeout`/
`setInterval` 是合法全局。定时器均随生命周期清理：

| 定时器 | 清理点 |
| --- | --- |
| `heartbeat.ts` ping/probe 定时器 | `Heartbeat.stop()`（clearInterval + removeEventListener） |
| `ws-signaling.ts` 重连定时器 | `disconnect()`（clearTimeout + manualClose） |
| `config-sync.ts` debounce 定时器 | `ConfigSync.stop()`（clearTimeout） |
| `node-host.ts` pollDeviceGrant 轮询 | 5 分钟 deadline 自结束 + generation 使结果失效 |
| `session.ts` DataChannel 超时 | `clearTimeout`（open 即清） |

### 10.4 ✅ Host↔Client 通信机制映射

指南 §5.5 的 `harness.handle`/`host.call` 是**动态插件**的包私有 JSON RPC 通道。deepc-link 是
**组合插件行**，其 client 半（`host-ui.ts`）是编译 bundle，与 node 半通信走
`ctx.webServer.register('/deepc')` 前缀路由 + 同源 `fetch`（`dsh-host-webserver` 官方 seam）。
两者定位不同、互不冲突：

| 机制 | 适用 | deepc-link 用法 |
| --- | --- | --- |
| `harness.handle`/`host.call` | 动态插件（进程内临时扩展） | 不适用 |
| `ctx.webServer.register` | 组合插件行的 node/client 同机通信 | `/deepc/*`（status/login/logout/allow/dev-mode/sync/conflict-resolve/disconnect） |
| RTC DataChannel | deepc 主站 ↔ 插件后端（跨设备数据面） | `deepc.*` / `session.*` / `workspace.*` unary + events 下行 |

### 10.5 结论

**deepc-link 无违反硬约束的偏移。** 两处「适用性说明」（定时器、通信通道）源于「组合插件行」
与「动态插件」的机制差异，非违规；一处「合理偏差」（模块级 polyfill）是 `node-datachannel`
复用浏览器 WebRTC 代码的必要前提，已记录改进方向。`ctx.get` ≡ `ctx.reflect.get` 已由 cordis
源码确认（`reflect.ts` `this.mixin('reflect', ['get', ...])`）。
