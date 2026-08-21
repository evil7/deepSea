# dsh 插件开发 + Cordis 框架共识

> 状态：**调研定稿** · 本文档是 deepc 对接 dsh 插件生态的**唯一共识底稿**
> 编写：2026-08-20 · 基于 deepseek-ai/deepseek-harness 源码与官方文档交叉核对
> 更新：2026-08-21（旧快照/monkey-patch 方案已废弃，见 §5 结论）
> 关联：`deepsea-deepc-bridge-plan.md`（deepc-bridge 规划，本文 §4/§5 是其载体选型依据）

## 1. 结论先行（TL;DR）

1. **dsh = 官方前端（React-free 对象层）+ vendored Cordis 插件框架**，一切能力（session、tool、agent-loop、LLM 适配器）都是插件，挂在同一个 `ctx` 上。
2. **插件只有三种形态**：函数 / 对象 / 类（`Service` 子类）。绝大多数场景函数形态足够。
3. **官方预留了「接新载体」的正统扩展点**：`AbstractApiClient`——子类只实现 `doFetch` 即可接入新传输；要拦截协议层则覆写 `callUnary`/`openMux`/`openHost` 虚方法。契约与基类保持不变。
4. **声纳互联的 monkey-patch 方案，本质上就是这个正统 seam 的「运行时等价物」**：`WebApiClient.doFetch` 就是 `globalThis.fetch`，`openMux`/`openHost` 就是 `new WebSocket`。patch 这两个全局对象，语义上等于「给 `WebApiClient` 换 transport aspect」。
5. **黑屏根因已定位到协议层**：`WebApiClient.readWebSocket` 里 `handleClose → enqueue({kind:'end'}) → generator return`，一旦伪造的 WebSocket 触发 `close`，流迭代器正常结束，`ConnectionController` 即判 `connection lost`。修复方向见 §5.4。

## 2. Cordis 框架（vendored 底座）

官方入口：`docs/cordis-primer.md`（五个核心概念）、`docs/cordis-tutorial/`（7 章实践）。

### 2.1 五个核心概念（primer 原文）

| # | 概念 | 含义 |
|---|------|------|
| 1 | **插件是实现 Service 的对象** | 函数（`inject` + `apply(ctx)`）或 `Service` 子类，生命周期由 Cordis 挂载 |
| 2 | **上下文是服务仓库** | 服务占据稳定 `ctx.<key>`（`ctx.tools`/`ctx.llm`/`ctx.sessions`），按 key 查找而非 import 实现 |
| 3 | **通过 `inject` 声明依赖** | 插件命名所需服务后等待其就绪，加载顺序由服务依赖表达，而非手动编排 |
| 4 | **类型化事件通信** | 事件名经 TS 声明合并定义，按 `emit`/`waterfall`/`parallel`/`serial` 分发 |
| 5 | **注册是可逆副作用** | 所有注册经 `ctx.effect()`/`ctx.on()`，reload/teardown 时自动撤销 |

### 2.2 分发模式与 waterfall

- `ctx.emit`：广播；`ctx.parallel`：并发；`ctx.serial`：顺序；`ctx.bail`：首个非空短路；`ctx.waterfall`：短路链。
- **waterfall 语义**：listener 签名带 `next`，决定是「包裹后继续」还是「短路」。拦截/策略类钩子（如 `agent/pre-step`、`tools/result`）用 waterfall，能力直调用 service 方法。

### 2.3 生命周期（`ctx.effect`）

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    console.log('effect registered')
    return () => console.log('effect cleaned up')  // disposer，卸载时运行
  })
}
```

- `ctx.plugin(fn)` 把函数**从代码**挂载为插件（与 YAML loader 逐项执行同义），返回 **fiber**（已加载插件实例的运行时句柄）。
- effect 主体在加载期运行，返回的 disposer 在卸载期运行——生命周期与插件一致的资源无需手动释放。
- HMR 卸载旧插件 → 清注册 → 载新代码 → 跑新 `apply`，不残留旧注册。

### 2.4 Loader 配置

- `@deepseek-ai/cordis-plugin-include` 解析 `!!js` 表达式节点；loader 在依赖激活后对插件上下文插值 `config`，在每次 mount 决策时对 loader 上下文插值 `disabled`。
- 配置项并发启动，列表位置**不保证**加载顺序——顺序由 `inject` 依赖决定。
- 解析失败的模块经 logger 报告（不 crash）；`apply` 抛错则进程终止（loud failure）。

## 3. dsh 插件开发路径

官方入口：`docs/user/develop/basic/index.md`（第一个插件）、`docs/user/develop/framework/index.md`（生命周期）。

### 3.1 三种形态

```ts
// ① 函数形态（多数情况足够）
export const name = 'hello'
export function apply(ctx: Context) { /* ... */ }

// ② 对象形态
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}

// ③ 类形态（插件对外提供服务时用）
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

### 3.2 配置（Config）

导出同名 `Config` 类型 + Schemastery schema（或任意 Standard Schema 校验器），`apply` 收到的 `config` 恒为完整校验值（schema 默认值兜底）。

### 3.3 node/browser 拆分

dsh 插件可拆成两个端：

- **node 端**：Node 侧 `apply`，普通 Cordis 插件。
- **browser 端**：通过 `package.json` 的 `dsh.client` manifest 声明 + `exports["./client"]` 导出浏览器入口，由 `client-modules` 增量扫描发现。
  - `dsh.client`：`platform: 'web'` 必填；可选 `inject`、`immediately`；`exports["./client"]` 缺失则扫描抛错。
- **纯 UI 插件**（如 `ui-cordis`/`cordis-client-runner`）：node 端是**空 `apply`**（只为让插件出现在 host `cordis.yml`/Loader），browser 端走 `exports["./client"]`。

### 3.4 client-modules 加载模型

- 执行一个插件 bundle **只注册其 factory**：`window.__ModuleLoader__.load({ id, factory })`（lazy CJS）。
- 增量扫描；畸形声明聚合为 `AggregateError`。

### 3.5 打包与安装（`docs/user/develop/basic/publish.md`）

```
hello-plugin/
├── package.json      # declares dsh.bundle
├── cordis.patch.yml  # layer applied when a profile lists this bundle
└── index.js          # plugin modules the patch rows reference
```

- `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
- `dsh plugin add` 安装；profile 列出 bundle 时应用 patch 层。无 `dsh.bundle` 声明则只作普通依赖，激活不了任何 layer。

## 4. 关键 seam：`AbstractApiClient`（正统扩展点）

源码：`packages/host/apiproxy/src/fetch/client.ts`（基类）+ `packages/client/connection/src/client/web-api-client.ts`（浏览器子类）。

### 4.1 基类持有的协议不变量

官方注释原文：`AbstractApiClient` 持有**全部协议不变量**——rpcId mint、四象限信封 wrap/unwrap、zod 解析、SSE 帧解码、payload 直传的 `IApiClient` 域方法。平台差异只体现在两个 aspect：抽象 `doFetch`（transport）+ 可覆写 `onEnvelope`（tap）。

| 路径 | 内容 |
|------|------|
| `callUnary` | mint → tap → POST 全形 → `serverResponseSchema` parse → **rpcId 回显校验**（不符 throw）→ tap → 窄形 |
| `readSse` | streaming fetch（非 EventSource）、`\n\n` 分帧、`data:` 拼接、ServerRequest 全形 parse、tap、窄形 `RpcRequest<frame>` |
| `respond` | client-response 透传（rpcId 回填不 mint），`rpcReceiptSchema` parse |
| unary 时限 | 默认 30s；`host.pickDirectory`/`command.execute` 不设限但保留调用方取消；流不设限 |

### 4.2 三个官方 Provider（子类表）

| 子类 | transport | 用途 |
|------|-----------|------|
| `WebApiClient` | `globalThis.fetch` 上行 + 每条逻辑流一条同源 WebSocket 下行 | 浏览器客户端（物理边界） |
| `FixtureApiClient` | 不用（协议层覆写） | 无 server 的 UI 开发（`?fixture`），覆写 `callUnary`/`openMux`/`openHost`/`respond`，自己就是假 server |
| `InProcessApiClient` | `toFetchHandler(api).fetch` | `new InProcessApiClient(toFetchHandler(api))` 永不碰网络 |

### 4.3 官方「接新载体」指引（原文）

> **Plug in a new carrier: subclass `AbstractApiClient` implementing only `doFetch`; to intercept at the protocol layer (like the fixture), override the `callUnary`/`openMux`/`openHost` virtuals instead. Contract and base class stay unchanged.**

即：接新载体 = 继承 `AbstractApiClient` 只实现 `doFetch`；要拦截协议层（像 fixture 那样）= 覆写 `callUnary`/`openMux`/`openHost`。**契约与基类不变**。

### 4.4 关键事实：`connection` 插件硬编码 carrier，无注入点

```ts
// packages/client/connection/src/client/index.ts
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = fixtureClient ?? new WebApiClient()   // ← 硬编码，无 DI 点
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()
  // ...
  ctx.provide('connection', handle)
}
```

## 5. 操作互联载体选型（对 deepc-bridge 的直接结论）

> 2026-08-21 结论更新：monkey-patch 方案（patch `window.fetch`/`window.WebSocket` 复刻官方
> 前端）已随「寄生快照」方案一并废弃。deepc-bridge 的「操作互联」采用**自实现 chatUI +
> `WebRtcApiClient` 正统子类**（§5.2），不再 patch 全局对象。下方 §5.1/§5.4 的历史分析
> 仅作「为何 monkey-patch 有黑屏风险」的存档依据。

### 5.1 （已废弃）monkey-patch 方案 = 正统 seam 的运行时等价物

`WebApiClient` 的 transport aspect 只有两处：

```ts
protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)        // ① unary/respond 上行
}
protected override openMux(...): AsyncIterable<RpcRequest<MuxFrame>> {
  return this.readWebSocket(MUX_EVENTS_PATH, ...)   // ② mux 下行
}
protected override openHost(...): AsyncIterable<RpcRequest<HostFrame>> {
  return this.readWebSocket(HOST_EVENTS_PATH, ...)  // ③ host 下行
}
```

deepc 远端 patch `window.fetch` + `window.WebSocket`，精确命中这三处。**协议不变量（rpcId mint、信封 wrap/unwrap、zod、SSE 帧解码）仍由官方基类保证，并未绕过 seam**。因此：

- 界面由官方前端原生渲染（零复刻）——保持不变；
- patch 的不是「协议」，而是「transport aspect」——这正是官方 `AbstractApiClient` 抽象要隔离的那一层。

### 5.2 更正统的长期方案：`WebRtcApiClient extends AbstractApiClient`

```ts
class WebRtcApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    // DataChannel：发 (method, payload, rpcId) 帧，等 server-response 回帧
    return this.dataChannelUnary(input, init)
  }
  protected override openMux(...) { return this.dataChannelStream('mux', ...) }
  protected override openHost(...) { return this.dataChannelStream('host', ...) }
}
```

- 协议不变量全交给基类，只写「DataChannel 传输」一个 aspect——无全局副作用、无 WebSocket 语义复刻负担。
- **代价**：`connection` 插件硬编码 `new WebApiClient()`，无注入点。要落地必须 fork 官方前端一行（或给官方提 PR 加 carrier 注入点）。

### 5.3 两条路线对比

| 维度 | A. monkey-patch（现状） | B. `WebRtcApiClient`（正统） |
|------|------------------------|------------------------------|
| 协议不变量 | 官方基类保证 ✅ | 官方基类保证 ✅ |
| 改动面 | 零改动官方前端 | fork 官方前端 1 行 |
| 全局副作用 | patch `fetch`/`WebSocket`，需过滤 + 复刻 WS 语义 | 无 |
| 黑屏风险 | 高（见 §5.4，伪造 WS 的 close 语义） | 低（流由自己掌控） |
| 维护成本 | 随官方 `WebApiClient` 内部变化 | 随 `AbstractApiClient` 契约变化（更稳定） |
| 落地难度 | 已跑通 | 需 fork/PR + 重建快照 |

**结论（2026-08-21 定稿）**：**直接采用 B（`WebRtcApiClient` 正统子类）**，废弃 A。
自实现 chatUI 直接继承 `AbstractApiClient`，只写「DataChannel 传输」一个 aspect，把
「复刻 WebSocket 语义」这个最脆弱的点（黑屏根因，见 §5.4）从方案里彻底剔除。
详见 `docs/deepsea-deepc-bridge-plan.md` §5.2。

### 5.4 黑屏根因（协议层精确定位）

`WebApiClient.readWebSocket` 的关闭路径：

```ts
const handleClose = (): void => { enqueue({ kind: 'end' }) }   // ← socket close → 流结束标记
// ...
socket.addEventListener('close', handleClose, { once: true })
// ...
while (true) {
  while (inbox.length > 0) {
    const item = inbox.shift()
    if (item.kind === 'end') return        // ← generator 正常 return
    yield item.envelope
  }
  await new Promise(resolve => { wake = resolve })
}
```

`for await` 消费这个 AsyncIterable 的 `ConnectionController`，在流结束时判定 `connection lost`。

**黑屏 = 伪造的 WebSocket 触发了 `close`**（或等价的流迭代器 return），导致 mux/host 两条流「正常结束」。真实场景下这两条 WebSocket 是长连接，只在 host 真正断开时才 close。

**修复方向**：
1. 伪造 WebSocket 只在 **DataChannel 真正断开**时才派发 `close`，绝不因快照传输完成、某个逻辑帧边界而 close。
2. mux / host 两条下行流在远端各保持**独立长开**，与 DataChannel 生命周期一一对应，而非复用/重建。

### 5.5 落地结论（取代旧「对 suite-sonar-interconnect.md 的更新建议」）

- 黑屏根因（伪造 WS 的 close 触发 `readWebSocket` 流正常结束）已不再影响新方案——
  新方案无伪造 WebSocket，chatUI 经 `WebRtcApiClient` 自掌控流生命周期。
- `AbstractApiClient` 的 `doFetch`/`openMux`/`openHost` 三处 transport aspect 是
  「操作互联」的正统扩展点，不再以 patch 全局对象的方式实现。
- 载体选型依据已收敛到 `docs/deepsea-deepc-bridge-plan.md` §5（自实现 chatUI + DataChannel）。

## 6. 参考（官方源码路径）

- `docs/cordis-primer.md` / `.zh.md`：Cordis 五大概念
- `docs/cordis-tutorial/`：7 章实践（01 插件 / 02 生命周期 / 03 服务 / 04 事件 / 05 配置 / 06 组合 HMR / 07 进 harness）
- `docs/user/develop/basic/index.md`：第一个 Harness 插件
- `docs/user/develop/basic/publish.md`：打包安装（`dsh.bundle` + `cordis.patch.yml`）
- `docs/user/develop/framework/index.md`：插件与生命周期 / HMR
- `packages/host/apiproxy/src/fetch/client.ts`：`AbstractApiClient` 基类 + `InProcessApiClient`
- `packages/client/connection/src/client/web-api-client.ts`：`WebApiClient`（浏览器子类）
- `packages/client/connection/src/client/index.ts`：`connection` 插件（carrier 硬编码点）
- `packages/client/connection/src/client/fixture.ts`：`FixtureApiClient`（协议层覆写示例）
- `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`：四象限消息模型 + fetch 载体 + 子类表
