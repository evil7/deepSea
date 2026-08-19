# 深海套装 · 多端互联（WebRTC + 私有 gist 加密同步）

> 状态：**规划中（M2/M3）** · 所属：深海套装（DEEPSEA KIT）特色能力之一
> 编写：2026-08-19（第二轮细化）· 关联文档：`deepsea-suite-deepc-architecture.md`（整体架构）

## 1. 定位与目标

让用户**以 deepc.cn 站点为统一界面**，在桌面端、移动端、远程浏览器之间实现多端调用 dsh、
对话同步、主题/配置/插件清单同步——**且不为此暴露任何自建后端或端口**。

核心安全主张（本方案存在的根本理由）：

- **不用 nginx 反代**：官方 dsh 是 client-server，远程访问通常要用户自建 nginx 反代暴露端口，
  极易配置错误带来安全风险。deepc 方案**零端口暴露、零自建中继**。
- **私有 gist 作持久同步载体**：登录后，用**用户自己的 GitHub API** 把**端到端加密**的数据
  写入**用户私有 gist**；数据只落在用户自己账号名下，且对 GitHub 本身也是密文。
- **WebRTC 作实时数据面**：在线时用 P2P DataChannel 直连（低时延、加密、可 NAT 穿透），
  gist 作「离线信箱 + 跨设备兜底」，二者互补。
- **社区共识**：把「自协商加密 + 私有 gist 同步」这套安全方案开放为社区共识规范，
  任何客户端都可按同一格式读写，形成去中心化的同步生态。

## 2. 官方调查结论（dsh 现有连接层 + gist 支持情况）

经核对 `deepseek-ai/deepseek-harness`：

- **dsh 目前是 client-server 架构，无 P2P**：连接层在 `packages/client/connection`
  （`ConnectionController`），浏览器用 HTTP POST（上行）+ 每逻辑流一条 WebSocket（下行）；
  `ctx.connection.rpc`（JSON-RPC）；关键抽象 `IApiClient`（`InProcessApiClient` /
  `WebApiClient` / `FixtureApiClient`）。
- **远程浏览器限制**：`A remote browser cannot access the privileged settings API, so its
  selection remains process-local`——远端浏览器无法写回 Host 设置，这正是需要 gist 同步的原因。
- **gist 在官方库无封装（0 命中）**：官方不提供 gist 读写，deepc 的 gist 同步属**自研方案**，
  由前端/本地用 `octokit.gists.create/get/update` 直调（符合本站「前端 octokit 直调」红线）。

> 结论：多端互联 = **WebRTC DataChannel（实时 P2P）+ 私有 gist（端到端加密的持久同步）**，
> 信令/同步都不依赖自建服务器；deepc.cn 只提供 OAuth 与静态界面，不承载、不看见任何业务数据。

## 3. 架构

```
┌──────────────┐   WebRTC DataChannel（实时 P2P，加密）    ┌──────────────┐
│  桌面端 deepc │ ◄══════════════════════════════════════► │  移动端 deepc │
│  (host A)    │        会话/配置/主题/清单帧                │  (host B)    │
└──────┬───────┘                                          └──────┬───────┘
       │ 自协商加密（端到端，密钥不出设备）                        │
       │                                                          │
       │   离线/兜底：写入私有 gist（用户 GitHub API，密文）       │
       └──────────────►  gist(私有)  ◄──────────────────────────┘
                        · 只存密文，GitHub 亦不可读
                        · 登录后 octokit.gists 直调

deepc.cn 站点（统一界面）：OAuth 登录 + 主题构造 + 插件管理 + 同步面板
（不承载/不代理业务数据，不要求用户 nginx 反代）
```

- **信令/配对**：WebRTC 仍需信令交换 SDP/ICE。选项 A：deepc.cn Worker 做一次性轻量信令
  （复用 OAuth 身份 + KV，短 TTL）；选项 B（更贴合「零服务器」）：信令也走私有 gist——
  双方把 offer/answer 加密写入同一 gist，另一端轮询取回。
- **数据面**：`RTCDataChannel`（`session` / `config` / `plugins` 三通道）+ 私有 gist 兜底。
- **身份**：复用 OAuth 会话；加密密钥由**自协商**产生（如各设备从用户主密钥派生的对称密钥，
  或 WebRTC 握手中的派生密钥），绝不写入 gist 明文。

## 4. deepc 互联插件架构

在 Cordis context 上新增 **`ctx.peer`** 服务，与 `ctx.connection` 并列：

```ts
export const name = 'deepc-peer'
export const inject = ['settings', 'credentials']

export function apply(ctx: Context) {
  ctx.peer.register({
    // 加密：自协商密钥派生（端到端，密钥不出设备）
    encrypt: (payload) => seal(payload, deriveKey()),   // AES-GCM
    decrypt: (blob) => open(blob, deriveKey()),
    // 实时：WebRTC DataChannel
    channels: {
      session: openChannel('session'),   // 对话同步：会话事件流转发
      config: openChannel('config'),     // 主题/设置同步
      plugins: openChannel('plugins'),   // 插件清单/收藏同步
    },
    send: (channel, frame) => sendFrame(channel, frame),
    on: (channel, handler) => subscribeFrame(channel, handler),
    // 持久兜底：私有 gist（登录后 octokit.gists 直调）
    syncToGist: (blob) => upsertGist('deepc-sync', blob),   // 写密文
    pullFromGist: () => fetchGist('deepc-sync'),             // 读密文
  })
}
```

- **实现库**：Node 端 WebRTC 用 `werift`（纯 TS）或 `@roamhq/wrtc`；浏览器原生 `RTCPeerConnection`。
  gist 用 `@octokit/rest` 的 `gists.create/get/update`（`public: false` 私有）。
- **帧协议**：`{ kind, payload }` JSON 帧，密文后写 gist / 走 DataChannel。

## 5. 场景落地（统一界面调用 dsh）

1. **对话同步**：桌面端把当前 session 增量事件（加密）写私有 gist + 实时推 DataChannel；
   移动端在 deepc.cn 打开即拉取密文解密 → 恢复完整会话 → 继续调用 dsh。
2. **主题/设置同步**：`config` 通道同步 `DeepcTheme` 主题定义（见主题文档）与 settings 的
   user 层，各端 `register` / `watch` 自动生效。
3. **插件清单同步**：`plugins` 通道同步收藏/已装清单，站点「已装状态」由此上报。
4. **免反代远程使用**：用户无需暴露 dsh 端口；需要时通过 gist/WebRTC 把「对话与配置」同步到
   当前设备上的 dsh 继续，安全边界始终在自己账号与端到端加密之内。

## 6. 里程碑与完成标准

- [ ] M2-1：自协商密钥派生 + AES-GCM 端到端加密（密钥不出设备）
- [ ] M2-2：私有 gist 读写封装（octokit.gists，密文存储 + 版本/并发控制）
- [ ] M2-3：`ctx.peer` 服务 + WebRTC DataChannel 建连（Node `werift` / 浏览器原生）
- [ ] M2-4：`config` 通道主题/设置同步 + `plugins` 通道清单同步（端到端）
- [ ] M3-1：`session` 通道对话同步（增量事件 + 恢复）
- [ ] M3-2：信令 gist 化（可选，彻底零服务器）与社区共识文档

## 7. 参考

- 官方连接层：`packages/client/connection`（`ConnectionController` / `IApiClient`）
- 官方架构笔记：`.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md`、
  `2026-07-19-gui-layering-and-rpc-protocol.md`
- 官方主题远端限制：`packages/client/ui-theme/README.md`（remote browser process-local）
- gist API：`octokit.gists`（`create/get/update`，`public:false`）
- WebRTC 参考：`werift`（纯 TS）、`peerjs` / `simple-peer`、`trystero`（无服务器信令思路）
- OAuth：`docs/deepsea-oauth-worker.md`（deepc.cn Worker，可选作信令面）
