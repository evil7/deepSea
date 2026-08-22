# deepc-bridge 规划 —— 操作互联 + 工程同步

> 状态：**实现中（S1 底座已打通）** · 本文档是 deepc 的**唯一正确方案文档**
> 编写：2026-08-21 · 取代旧「声纳互联」（寄生快照，`deepsea-suite-sonar-interconnect.md`）
> 与「镜像 + 共享」双模式（`deepsea-sonar-mirror-shared-plan.md`），两者均已废弃删除
> 关联：`deepsea-cordis-plugin-consensus.md`（官方插件 seam）· `deepsea-oauth-worker.md`（OAuth）
> · `deepsea-auth-migration-evaluation.md`（Auth/D1）

---

## 0. 开发理念与红线（统一底稿）

> 本节是 deepc-bridge 全部开发的**理念 + 红线唯一权威**；`.github/instructions/deepc-bridge.instructions.md`
> 与 skill `dsh-deepc-interconnect` 均由此派生。改动前必读。

### 0.1 四条理念

1. **Worker = auth 最小边界**：`apps/worker` 只承载身份与授权（OAuth / 设备授权 / 设备注册 /
   信令 DO / 账号配置 / 审计）；**数据面一律 P2P，绝不进 Worker**。
2. **插件前后端分层**：前端（browser）只做展示；后端（node）承载连接层 + 逻辑 + 底层能力。
3. **能走 P2P 绝不走 Worker；能走 WS 消息绝不发 HTTP；能一次性/按需绝不轮询**（额度红线）。
4. **结构化事件 + 自实现 chatUI**：不直播 DOM、不复刻官方前端、不 monkey-patch。

### 0.2 六条红线

1. 禁止给 Worker 加 `/api/*` 代理路由（dsh 官方 gateway 独占，数据面走 P2P）。
2. 禁止信令退回轮询（WS + DO 是唯一通道）。
3. 禁止会话消息/工作区/配置详情落 Worker 存储（走 RTC 直传）。
4. 禁止复刻官方前端 / DOM snapshot / monkey-patch `fetch`/`WebSocket`。
5. 禁止插件端在浏览器侧注册/心跳/连信令/派生 nodeId（token/nodeId 一律 node 后端注入自持）。
6. 禁止密钥/device_token 落明文（Worker 只见 AES-GCM 密文）。

---

## 1. 一句话定位

**deepc 只做一个本地插件 + 一个远程 RTC 通信中间件**：

- 插件包名 **`deepc-bridge`**（目录 `packages/deepc-bridge`），是挂到 dsh host 的 Cordis 插件，
  未来还承载插件管理、主题管理等能力注入（故不叫 sonar）。
- 插件内部的核心通信底座是 **`deepc-sonar-bridge` 中间件**：安全加密、自动分包、远程 RTC
  通信（NodeRTC-WebRTC 实现，即 node-datachannel headless 端点）。
- 在中间件之上实现**两个语义正交的功能**：

| 功能 | 语义 | 一句话 |
|------|------|--------|
| **操作互联** | 远程控制 | deepc 主站**自实现 chatUI**，经加密 RTC 通道调本地 dsh host API |
| **工程同步** | 数据迁移/备份 | 登录后，把本地**工作区 + 聊天记录**经同一加密 RTC 通道实时传输 |

**核心原则**：操作互联靠「自实现 chatUI + 只调稳定 API」隔离官方前端变动风险；
工程同步靠「同一中间件 + 自动分包」复用全部安全底座。两者**共用同一套
`deepc-sonar-bridge` 底座**（信令 / 加密 / 配对 / 探活 / 帧协议 / 可靠分包）。

---

## 2. 为什么推翻旧方案（镜像 / 快照 / 复刻）

| 旧方案 | 核心问题 | 处置 |
|--------|---------|------|
| 寄生快照（Plan B，`suite-sonar-interconnect`） | 需要 SW 静态壳 + 路径重写 + snapshot 实时流 + on-demand 回源，四层复杂度 | ❌ 废弃 |
| 镜像 Mirror（抓 DOM 树 + CSS） | 受控组件 native setter、坐标归一化、循环防环、Canvas/Shadow DOM 边界，永远修不完 | ❌ 废弃 |
| 复刻官方 dsh 前端（零走样） | 官方破坏性更新 / 布局接口变动 → 零维护承诺落空 | ❌ 废弃 |
| **DOM snapshot + MutationObserver 双向控制**（2026-08-21 再评估） | 快照同步链路可行（rrweb 同款），但**操作回传链路**（坐标→推测元素→回传→dispatch 触发 React）是 hack 堆砌：受控输入需 native setter、DOM 路径随官方结构漂移、循环防环、全量 DOM+状态暴露 | ❌ 否决（见下） |

> **2026-08-21 再评估结论**：用户重新提出「DOM snapshot + MutationObserver 增量同步 +
> 远端操作蒙版捕捉回传」。经评估，拆成两条链路——**快照同步（host→远端）技术成熟**
> （rrweb 的 session-replay 思路），但 **操作回传（远端→host）才是 deepc 双向控制的核心，
> 恰恰最脆弱**：远端 DOM 是「死的」（无 React fiber / 无事件处理器 / 无状态），要靠
> 坐标 → `elementFromPoint` 推测目标 → 回传元素标识 → host `dispatchEvent` 触发 React 合成
> 事件；受控输入框更需 React 官方文档里的 native-setter hack。且 DOM snapshot 是「最依赖
> 官方 DOM 结构」的方案，官方前端改个 class/层级即崩——与本节否决「复刻官方前端」是
> **同一根因**。
>
> **核心洞察**：DOM 是「渲染结果」，session 事件流才是「真相」；官方前端与自实现 chatUI
> 都是「拿事件流 → 渲染 DOM」的同一次渲染的两份拷贝。同步真相（事件流）永远比同步渲染
> 结果（DOM）稳。故**维持「结构化事件 + 自实现 chatUI」主线不变**；DOM snapshot 仅在
> 未来若出现「只读观战/协助」需求时，作为独立旁路单独评估（rrweb 已证其可行性）。

**新方案的隔离思路**：不直播像素、不复刻 DOM、不寄生快照。deepc 主站**自己写一个 chatUI**
（渲染会话列表 + 对话流 + 发送消息），它只调用本地 dsh host 的**稳定 API**（`session.list` /
`session.create` / `session.send` / `llm.*` 等），接触面收敛到「API 契约 + RTC 通道」两个
稳定底座。官方前端怎么改、布局怎么变，对 chatUI **零影响**。

---

## 3. 技术路线：NodeRTC-WebRTC（node-datachannel）

### 3.1 选型结论

本地 dsh host 是 Node 进程，deepc 插件（node 端）需要**无浏览器**的 WebRTC 端点：

| 候选 | 结论 |
|------|------|
| **node-datachannel** | ✅ **主线**。libdatachannel（C++，MPL-2.0）的 Node.js 绑定，headless WebRTC 端点 |
| PeerJS | ⚠️ 备选。自带 broker，但信令已自建（worker `/ws/signal` DO 信号房），徒增部署 |
| golang 插件 | 📋 中长期。能力最强，但需确认官方运行时是否允许非 JS 进程 |

### 3.2 node-datachannel 关键事实

- **API 与浏览器对齐**：`PeerConnection`（`createPeerConnection` / `setLocalDescription` /
  `setRemoteDescription` / `onLocalCandidate`）+ `DataChannel`（`createDataChannel` /
  `onMessage` / `send`），迁移成本低。
- **ICE backend = libjuice**：自带 STUN/TURN，`iceServers` 配置格式与浏览器一致
  （`stun:stun.l.google.com:19302`）。
- **DataChannel 可靠性**：`ordered` + `reliable`（默认）可配，可靠有序是工程同步的基线。
- **预编译二进制**：win/mac/linux × x64/arm64 预编译，`pnpm install` 即装，无编译链。
- **与浏览器互通**：标准 SCTP/DTLS/UDP 协议栈，与 Chromium/Firefox/Safari 互通。

### 3.3 两端进程模型

```
[本地 dsh host 进程 (Node)]
   └─ deepc-bridge node 端 (Cordis 插件)
        ├─ ctx.apiProxy（dsh 本地功能网关，官方 seam）
        ├─ toFetchHandler(ctx.apiProxy) → 本地 API 处理器
        ├─ node-datachannel PeerConnection（headless 端点）
        │     └─ DataChannel（deepc-sonar-bridge 帧）
        └─ 信令客户端 → worker /ws/signal（DO 信号房，WS 推送）

[远端 deepc 主站 (浏览器)]
   └─ 自实现 chatUI（React）
        ├─ RTCPeerConnection（浏览器端点）
        └─ 信令客户端 → worker /ws/signal
```

**关键桥接点**：`toFetchHandler(ctx.apiProxy)` 把官方 API 网关变成「本地 fetch handler」，
远端 chatUI 的 API 调用经 DataChannel 帧回本地命中该 handler，响应原路返回。这正是官方
`InProcessApiClient` 的「transport 换成 DataChannel」变体，符合 `AbstractApiClient` 正统
扩展点（见 `deepsea-cordis-plugin-consensus.md` §4）。

### 3.4 前后端分层与两条正交链路

deepc-bridge 作为 Cordis 插件，天然分**前端（browser）**与**后端（node）**两个运行时。
本节是**目标架构**（含实现进度标注），核心原则：**前端只做展示交互，逻辑/连接/底层能力全部
在后端**。

#### 运行时边界

| 端 | 运行环境 | 职责 | 准入边界 |
|----|---------|------|---------|
| **插件后端（node）** | dsh host Node 进程（`index.ts` `apply` 启动） | 设备注册/心跳、WS 信令（DO 信号房）、配置同步、`deepc.*` 底层能力、HTTP 路由 | 能 `node:os` / `node:fs`；唯一的“真本机”执行者 |
| **插件前端（browser）** | dsh 页面 `127.0.0.1:3080`（`host-ui.ts` 悬浮球 + Sheet） | 只读展示：登录态/开关/同步/断开 | 无 localStorage 之外的逻辑；**不**注册/心跳/连信令 |

> 关键点：**前端** `localStorage` 里只有 token 等**展示用**状态，它无法（也不应）执行 `node:fs` /
> `node:os`。所以**真本机能力只能在插件后端**。这也是为什么 deepc 要“分前后端”——前端只是
> 一个在 dsh 页面上浮动的展示壳，真实连接与文件操作全部在后端进程内完成。

#### 两条正交链路（务必分清）

| 链路 | 通道 | 承载内容 | 语义 |
|------|------|---------|------|
| **① 主站 sonar ↔ 插件后端** | WebRTC DataChannel（信箱信令） | `deepc.*`（os/fs 能力）+ `session.*` / `workspace.*` 等本地 API | **远端远程控制**：跨设备枚举远端主机、调本地 dsh 稳定 API |
| **② 插件前端 ↔ 插件后端** | 后端专用 HTTP 前缀路由（`webServer.register`，如 `/deepc`） | auth/state（token/登录态/开关/同步） | **同机凭证传递**：前端只展示，把登录结果同步给后端 |

> **结论**：`deepc.fs.listDirectories` / `deepc.os.hostname` 这类**底层能力**，是服务链路①
> （主站 sonar 跨设备 RTC 命令）的，由后端 `deepc-api.ts`（`wrapLocalApi`）在 node 进程内执行
> 真实 `node:fs` / `node:os`。而链路②的 token/state 传递，走**后端专用的前缀路由**
> （非 dsh 官方 `/api` —— 该通道被官方 gateway 独占，`RpcMethodMap` 编译期封闭，插件无法注入
> 自定义 method）。

#### 为什么链路②不用 dsh 官方 `/api`

- dsh 官方 `/api` 通道的 method 路由表（`RpcMethodMap`）是**编译期封闭**的，`/api/deepc.*`
  会 404，插件无法注入自定义 method（`methodFor` 查的是一张写死的 `UNARY_ROUTES` 表）。
- 官方 `/api` 的 interceptor 通道（`connection.rpc.intercept('/api', ...)`）**只能有一个**，
  已被官方 gateway 占用。
- 因此 token/state 传递走**插件自注册的前缀路由**（`ctx.webServer.register`，如 `/deepc`），
  与官方 `/api` 完全隔离，互不干扰。

#### 当前实现进度标注

- ✅ **已验证**：`deepc.*` 经 RTC → node 后端 `wrapLocalApi` 本地处理（`node:os`/`node:fs`）；
  `HostInfo.hostname` 经握手下发；设备 registry/心跳/WS 信令支持 token 注入。
- ✅ **已完成（链路②通道已切换）**：`node-host.ts` 已改用官方 `ctx.webServer.register` 注册
  `/deepc` 前缀路由（`NODE_CTRL_PATH='/deepc'`，含 status/login/logout/allow/sync/disconnect 六个
  POST 路由），**不再自起 3099 回环 server**。`index.ts` 声明 `inject:['webServer']` +
  `ctx.effect` 注册路由。前端 `host-ui.ts` 已改为**纯展示**：`deepcCall('*')` 经 `/deepc/*` 调
  后端，`bootstrapHostUi()` 不再接收 opts、不再在浏览器端注册/心跳/连信令。
- ✅ **已接通（新建工作区枚举系统路径）**：`deepc.fs.listDirectories` 已有调用方——主站
  `/sonar` 的 `FolderPicker`（`apps/web/src/components/sonar/folder-picker.tsx`）经
  `deepcClient.call("deepc.fs.listDirectories", { path })` 走链路①（RTC → node 后端
  `deepc-api.ts` 的 `wrapLocalApi` → `node:fs`）跨设备枚举远端主机目录树，取代旧的
  `workspace.readDir`（已不再走 `HttpLocalApi→3080` 的 workspace API）；Win 盘符切换 +
  Unix 根目录双模态，供「新建工作区」选路径。
- ⚠️ **待做**：token 目前后端 `NodeTokenStore` 仅内存自持（`restore()` 仅进程内复用）；
  跨 dsh host 重启的 token 持久化、`HttpLocalApi` → `toFetchHandler(ctx.apiProxy)` 零网络
  直连切换仍待后续（见 §9 疑点 3/5）。

---

## 4. 核心中间件：deepc-sonar-bridge

> 一个「安全加密 + 自动分包 + 远程 RTC 通信」的复用底座，两个功能都建立在它之上。

### 4.1 职责分层

```
deepc-sonar-bridge 中间件
├── 传输层 transport     —— node-datachannel ↔ 浏览器 RTCPeerConnection 的 DataChannel
├── 安全层 security      —— nodeId 派生密钥 + AES-GCM 信令加密 + 应用层数据加密
├── 分包层 framing       —— 大文件/长记录自动分块 + SHA-256 校验 + ACK/NACK + 乱序还原
├── 会话层 session       —— 信令交换（WS+DO）/探活(deepc:ping·pong)/连接生命周期
└── 应用帧 application   —— 操作互联帧（API 调用）+ 工程同步帧（数据迁移）
```

### 4.2 安全模型

| 项 | 机制 |
|----|------|
| 信令密钥派生 | `deriveNodeSignalKey(nodeId)` = HKDF(nodeId)（AES-GCM 加密 SDP，收件人 nodeId 派生） |
| 信令保密 | WS+DO 只透传密文，Worker/DO 不见明文 SDP；DO 分区键 `room:{githubId}` 账号隔离 |
| 归属校验 | nodeId 归属校验（同账号才能投递/接收）+ device_token/cookie 鉴权 + 频次限流（≤5 req/s） |
| 数据面加密 | WebRTC DataChannel 自带 DTLS；可选应用层 AES-GCM（自定义加密 key，见 Auth 文档） |
| 工程同步加密 | 同步帧走同一 DataChannel（DTLS + 可选应用层 AES-GCM），绝不经服务器明文 |
| 最小暴露 | 只桥本地 `/api`（127.0.0.1），绝不暴露 dsh host 端口公网 |

### 4.3 自动分包（工程同步的关键底座）

工程同步会传输**工作区文件 + 长聊天记录**，可能数百 KB～数 MB，DataChannel 单消息
有上限（SCTP 单消息理论 ~256KB，实践 16~64KB 更稳），必须**自动分包**：

- **分块**：按 `CHUNK_BYTES = 16KB` 切块，逐块 `base64`（`transfer.ts` 已有
  `bytesToBase64` / `concatBytes`）。
- **会话边界**：`txId` 隔离新旧批次帧串扰。
- **校验**：每文件 `sha256Hex`，收齐后比对。
- **确认/重发**：`file-ack` / `file-nack(missing[])`，`MAX_NACK_ROUNDS = 3` 限轮防死循环。
- **乱序还原**：slot 数组按标号落位，天然支持乱序。
- **背压**：`waitForDrain` 避免发送端打满 SCTP buffer。

> 该能力由旧 `snapshot-sender.ts` / `snapshot-receiver.ts` 的可靠传输框架**直接复用改造**，
> payload 从「前端静态资源」换成「工作区 + 聊天记录」字节。

---

## 5. 功能一：操作互联（远程控制 · 自实现 chatUI）

### 5.1 拓扑：chatUI → RTC → 本地 API

```
deepc 主站 chatUI                    DataChannel               本地 dsh host
─────────────                       ───────────               ─────────────
渲染会话列表/对话 ──API 帧──► DC ──API 帧──► api-bridge → LocalApi
  ▲                                        └─► 命中 session.list/create/send...
  └──────────响应帧── DC ◄──响应帧──────────────┘
  下行事件流（events.mux/host）◄── server-request 帧 ── 本地事件流
```

- **chatUI 自实现**：不复刻官方前端，deepc 主站自己渲染「会话树 + 消息流 + 输入框」。
- **只调稳定 API**：`session.list` / `session.create` / `session.send` / `host.describe` 等
  语义稳定的 RPC，不依赖官方 UI 结构。
- **下行事件**：`events.mux` / `events.host` 帧回灌，chatUI 据此刷新会话状态/流式输出。
- **本地端点（node 端）**：`api-bridge.ts` 绑定 DC，经 `LocalApi` 抽象落地——当前实现
  `HttpLocalApi`（HTTP fetch unary + WS 下行，访问 `127.0.0.1:3080`，已端到端验证）；
  未来切换 `toFetchHandler(ctx.apiProxy)` 直连官方网关（零网络）时仅换实现，调用方不变。

> **chatUI 已完整化（2026-08-21）**：主站自实现 chatUI 已从「会话列表 + 对话 + 发送」
> 扩展到与官方 dsh 前端操作对齐——两行 composer 工具栏（命令 / 访问模式 / 模型选择 +
> 推理等级）、设置 dialog 真实读写（`settings.describe`/`update`，含权限/语言/外观/
> Enter 行为/模型/插件清单 166 项）、`session.models`/`session.selectModel` 会话模型切换、
> `events.host` 的 `settings/document-updated` 实时同步、消息流（user/assistant/error/tool/
> 上下文注入）对齐。详见 `docs/deepsea-deepc-bridge-roadmap.md` M8。

### 5.2 载体：`WebRtcApiClient extends AbstractApiClient`

官方 `AbstractApiClient` 持有全部协议不变量（rpcId mint、四象限信封 wrap/unwrap、zod 解析、
SSE 帧解码），平台差异只在 `doFetch` + `openMux` / `openHost`。deepc 自实现 chatUI 直接
继承它，把 transport 换成 DataChannel：

```ts
class WebRtcApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.dataChannelUnary(input, init)   // 发 (method, payload, rpcId) 帧，等 server-response
  }
  protected override openMux(...) { return this.dataChannelStream('mux', ...) }
  protected override openHost(...) { return this.dataChannelStream('host', ...) }
}
```

- 协议不变量全交基类，只写「DataChannel 传输」一个 aspect，无全局副作用、无 WS 语义复刻。
- 相比旧 monkey-patch（patch `window.fetch` / `window.WebSocket`），**无黑屏风险**、无复刻负担。

### 5.3 操作互联帧协议（叠加在 DataChannel 之上）

```
unary         chatUI → host    { kind:'unary', rpcId, method, payload }
unary-result  host → chatUI    { kind:'unary-result', rpcId, result }
subscribe     chatUI → host    { kind:'subscribe', subId, stream:'mux'|'host' }
downstream    host → chatUI    { kind:'downstream', subId, envelope:ServerRequest }
downstream-end host → chatUI   { kind:'downstream-end', subId }
control       ping/pong        { kind:'control', cmd:'deepc:ping'|'deepc:pong', seq, ts }
```

### 5.4 并发与权限

- **会话隔离**：每个远端连接独立会话上下文，调用序列互不可见。
- **并发安全**：本地 API 调用串行化或按资源加锁（多人同时 `session.create` 幂等/有序）。
- **权限审计**：复用 `interconnect_log`；敏感操作（删会话、改凭据）二次验证。

---

## 6. 功能二：配置同步（+ session 迁移）

> 定位修正（2026-08-21）：原「工程同步 = 工作区 + 聊天记录」已收敛为「配置同步 +
> session 迁移」，详细方案与 D1/KV 存储偏向评估见
> `docs/deepsea-deepc-bridge-config-sync.md`。此处保留总体语义。

### 6.1 定位

deepc 插件的**多端一致性**对象从「工程」收窄到「配置」：

| 能力 | 语义 | 时机 | 数据规模 |
|------|------|------|---------|
| **配置同步**（本期） | theme / 模型 / 偏好 / 插件开关跨端一致 | 登录即同步，改动即广播 | 极小（KB 级） |
| **session 迁移**（后续） | 两 Node 在线时，某 session 聊天记录 A→B | 显式操作 | 中等（KB～MB） |
| ~~工作区同步~~ | ❌ 移除（每 Node 本地工程各异，不跨端） | — | — |

- **权威源 = D1**（`deepc_config`，worker 统一时间戳），**RTC 端到端 = 加速**（经
  信箱信令实时广播）。两者复用既有 node 端点 + 信箱信令底座，零新增后端。
- **时效优先级**：`last-write-wins` + worker 单调递增时间戳 + `node_id` 字典序 tie-break。
- **冲突处理**：key 级粒度 LWW；敏感配置 E2E 加密。

### 6.2 同步对象与方向

| 对象 | 内容 | 方向 | 存储 |
|------|------|------|------|
| 配置 config | deepc 插件配置项（key-value） | 双向（LWW） | D1 `deepc_config` |
| session 索引 | 迁移时 sessionId → 所在 Node 的索引 | 单向（迁移方向） | D1（仅索引） |
| session 聊天记录 | 迁移时消息流（正文） | 单向（RTC 直传） | 不经服务器 |

### 6.3 帧协议（session 迁移复用，叠加 DataChannel）

```
sync-hello         host → peer   { txId, chunkBytes, scope:'session', total }
sync-hello-ack     peer → host   { txId, chunkBytes }
sync-file-meta     host → peer   { txId, sessionId, mime, size, chunks, sha256 }
sync-file ×N       host → peer   { txId, sessionId, chunk, data(base64) }
sync-file-ack / -nack / sync-end / sync-done   同旧可靠传输框架
```

> 配置同步**不走帧协议**（走 D1 读写 + 信箱通知）；只有 session 迁移（大体积）复用
> `transfer.ts` 可靠分包帧。`scope` 从 `workspace|sessions` 收窄为 `session`。

### 6.4 一致性与冲突

- **配置**：LWW（`updated_at` 大者赢，worker 统一时钟）+ `node_id` tie-break（见
  config-sync 文档 §2）。
- **session 迁移**：显式点对点、单向，天然无并发冲突；目标端已存在同 sessionId 时
  提示用户覆盖/跳过。

---

## 7. 复用 / 改造 / 删除清单（现状 → deepc-bridge）

### 7.1 保留复用（确定性底座，随目录改名）

| 文件 | 复用点 |
|------|--------|
| `src/crypto.ts` | generateConnectId(nodeId) + HKDF 派生(deriveNodeSignalKey) + AES-GCM 信令加密 |
| `src/node-signaling.ts` | 信箱信封编解码（offer/answer 跨端契约，经 /ws/signal DO 推送） |
| `src/heartbeat.ts` | deepc:ping/pong 探活 |
| `src/transfer.ts` | base64 / sha256 / txId / concatBytes（自动分包工具） |
| `src/protocol.ts` | 帧协议类型 + 常量（改造：四象限信封保留，去 snapshot 帧） |

### 7.2 改造复用（保留文件、重写内部）

| 文件 | 改造方向 |
|------|---------|
| `src/index.ts` | node 端入口：注入 RTC polyfill + re-export host 会话 API + 数据面桥；后续接 `ctx.apiProxy` → `toFetchHandler` |
| `src/session.ts` | **零改动复用**：node 端经 `polyfill.ts` 注入 node-datachannel headless 端点（对齐浏览器 API） |
| `src/polyfill.ts` | 新增：把 `node-datachannel/polyfill` 的 `RTCPeerConnection` 等注入 globalThis |
| `src/local-api.ts` | 新增：`LocalApi` 抽象 + `HttpLocalApi`（fetch unary + WS 下行，访问本地 dsh host） |
| `src/api-bridge.ts` | 新增：node 端数据面桥，DC 帧 → `LocalApi` → 回传（操作互联数据面入口） |
| `src/client/index.ts` | browser 端：不再是「启动互联悬浮球」，改为 chatUI 引导 + 工程同步入口 |

### 7.3 删除（镜像/快照/复刻专属，本轮清理）

| 文件 | 废弃原因 |
|------|---------|
| `src/client-bridge.ts` | monkey-patch `fetch`/`WebSocket`（寄生快照专属） |
| `src/inject.ts` | 快照引导脚本（document.write 重放） |
| `src/relay.ts` | 本地同源重放器（快照方案） |
| `src/snapshot-sender.ts` | 快照发送（静态资源流） |
| `src/snapshot-receiver.ts` | 快照接收（静态资源流） |
| `src/host-bootstrap.ts` | 悬浮球 UI（镜像/快照入口） |
| `poc/`（rtc-datachannel.html 等） | POC 调试资产 |
| `apps/web/public/deepc/{inject.js,host-bootstrap.js}` | 快照静态产物 |

### 7.4 目录与包名变更

- 目录：`packages/deepc` → **`packages/deepc-bridge`**
- 包名：`@deepsea/deepc` → **`@deepsea/deepc-bridge`**
- 描述：从「声纳互联 bridge（寄生式透明桥接）」→「deepc 本地插件 + 远程 RTC 通信中间件
  （操作互联 + 工程同步）」

---

## 8. 落地顺序

1. **底座先行** ✅ 目录改名 `deepc-bridge` + 包名 + 清理废弃文件 + 保留底座编译通过。
2. **中间件打通** ✅（node 端）`session.ts` 经 `polyfill.ts` 注入 node-datachannel，node 端
   headless 端点 + 信令互通已验证（node↔node 端到端 PASS）；浏览器端互通随 chatUI 在 S2 落地。
3. **操作互联** ✅ node 端数据面桥（`api-bridge.ts` + `HttpLocalApi`）→ 主站自实现 chatUI
   （会话/消息流/composer/设置页/实时同步）已端到端贯通，并完整化对齐官方（见 §5.1 注）。
4. **工程同步 → 配置同步** ✅ 已收敛为「配置同步（D1 权威 + DO 推送 config-changed，已实现）
   + session 迁移（后续，RTC 直传 + D1 索引，见 `deepsea-deepc-bridge-config-sync.md`）」。
5. **账号能力** ⏳ 互联日志 + 30 天审计清理 ✅；自定义加密 key 待定（见 §9 疑点 5）。

---

## 9. 疑点清单（待推敲）

1. **node-datachannel 原生依赖** ✅ 已实测：`0.33.0` win-x64 预编译二进制正常加载，
   `polyfill` 入口对齐浏览器 API（`RTCPeerConnection`/`RTCDataChannel` implements `globalThis.*`）。
   mac/linux 待后续 CI 覆盖。
2. **NAT 穿透边界**：libjuice 支持 STUN，对称 NAT 仍需 TURN —— 是否自建 TURN，还是接受边界？
3. **`ctx.apiProxy` 精确桥接点**：确认 node 端能否拿到 `ctx.apiProxy`（inject 声明依赖），
   `toFetchHandler(apiProxy)` 是否可直接用于 DataChannel 帧 → 本地调用。当前用 `HttpLocalApi`
   （HTTP fetch 127.0.0.1:3080）兜底，零网络直连切换待验证。
4. **node 端进程模型**：headless 端点跑在 dsh host Node 进程内（Cordis 插件），还是独立
   Node 进程经 IPC 接 `ctx.apiProxy`？
5. **自定义加密 key**：配置同步已落地（非敏感明文 + 敏感 E2E），但「应用层自定义加密 key」
   尚未落地——待后续需要时评估。
6. **chatUI 完整交互范围**：会话列表/对话流/发送/composer/设置页/实时同步已实现 ✅；
   工具调用审批（approval/requested）、权限二次确认（Full access）等完整交互仍待后续。

---

## 10. 参考

- 插件开发 + Cordis 共识：`docs/deepsea-cordis-plugin-consensus.md`（§4 `AbstractApiClient` / `ctx.apiProxy` / `toFetchHandler`）
- OAuth：`docs/deepsea-oauth-worker.md` · Auth/D1：`docs/deepsea-auth-migration-evaluation.md`
- node-datachannel（libdatachannel Node.js 绑定）：API 与浏览器 `RTCPeerConnection` 对齐
- 旧方案（已废弃，供对照）：镜像+共享 `deepsea-sonar-mirror-shared-plan.md`、寄生快照
  `deepsea-suite-sonar-interconnect.md`
