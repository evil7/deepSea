# 深海套装 · deepc 基础插件架构规划

> 状态：**规划中（M2 起）** · 统领：深海套装（DEEPSEA KIT）三大特色能力的统一底座
> 编写：2026-08-19（第二轮细化）· 关联：`deepsea-suite-theme.md` / `-plugin-management.md` / `-webrtc-interconnect.md`

## 1. 一句话定位

**deepc 是「深海套装」的本地执行器与安全底座**：一个符合官方 Cordis 规范的 dsh 插件（组合包），
把「一致主题（local/remote）、插件集中管理、多端互联（WebRTC + 私有 gist 加密同步）」三大能力
在用户本地落地，同时保证映射安全、路径隔离与二次验证。deepc.cn 站点是统一入口（发现/可视化/
分享/同步面板），deepc 是执行与同步的底座；全程零自建后端、零端口暴露（免 nginx 反代风险）。

## 1.1 三大特色能力 ↔ 文档映射（第二轮细化定稿）

| 特色 | 一句话主旨 | 文档 |
|------|-----------|------|
| **多端互联** | WebRTC 实时 P2P + 登录后把自协商加密数据写私有 gist，deepc.cn 统一界面多端调用 dsh/对话同步，形成社区共识，免 nginx 反代风险 | `-webrtc-interconnect.md` |
| **一致主题** | local（`theme.register` 直接移植优秀主题）/ remote（P2P/gist 同步）双层框架 + `/theme-generate` 页面 | `-theme.md` |
| **插件管理** | 本地管理点注入（Settings slot）+ 官方 `dsh plugin` 接入 + 插件/主题统一设置页 + 主题分享页 | `-plugin-management.md` |

## 2. 前置调研：官方插件构造文档、方式与参考仓库

> 本节是「全面调查与记录」的结论，是 deepc 开发前必须遵守的规范基线。
> 来源：`deepseek-ai/deepseek-harness` 源码与文档（2026-08 核对）。

### 2.1 官方框架与核心概念

| 概念 | 说明 |
|------|------|
| **Cordis** | dsh 的插件框架（vendored `@deepseek-ai/cordis`）：插件向共享 Context 贡献 service、typed event、reversible effect；注册是「效果」，插件卸载时自动回滚。 |
| **everything is a plugin** | 模型适配器、工具注册表、会话日志、agent loop 本身都是插件，可从配置替换；没有需要打补丁的特权内核。 |
| **Context / Fiber** | `ctx.plugin(child)` 创建子 Fiber，继承父 context、独立生命周期；`fiber.dispose()` 递归卸载。 |
| **inject** | 插件声明依赖的服务名，`apply` 执行前依赖已就绪。 |
| **schemastery** | vendored `@deepseek-ai/schemastery`，用 `z` 定义配置 schema（`z.object/z.string/z.number/z.union/...`），驱动设置表单与校验。 |

### 2.2 插件三种形态

```ts
import type { Context } from '@deepseek-ai/cordis'

// 1) 函数（最常用）
export const name = 'my-plugin'
export function apply(ctx: Context) {}

// 2) 对象
export default { name: 'my-plugin', inject: ['tools'], apply(ctx: Context) {} }

// 3) 类（暴露服务时才用）
import { Service, type Context } from '@deepseek-ai/cordis'
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

### 2.3 清单与分发（profile / bundle）

- **profile**：Harness home 里的具名组装，列出叠放的 bundles、存放树外插件、保存用户的 `cordis.patch.yml`。
- **bundle（组合包）**：Cordis 配置行 + 挂载代码的分发格式，插入内容可被上层 patch。
- **manifest**：`package.json` 的 `dsh` 字段——`dsh.profile` 列 profile 的 bundles，
  `dsh.bundle.patch` 指向组合包的 `cordis.patch.yml`。
- **安装**：`dsh plugin --profile <name> <args>` 转发 pnpm，成功后按已安装状态对账 `dsh.profile.bundles`。

```json
{
  "name": "deepc",
  "type": "module",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### 2.4 工具插件与配置注册

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet', description: 'Greet someone.',
    parameters: { name: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) { return `Hello, ${args.name}!` },
  }))
}
```

```ts
// 配置注册（settings namespace + schema）
const scope = ctx.settings.register(settingsNamespace('deepc'), ConfigSchema, { base: DEFAULT })
scope.watch((next) => { /* 热更新 */ })
```

### 2.5 客户端/服务端拆分

- host 半 `src/index.ts`：即使纯 UI 插件也保留空 `apply`，使其出现在 host 的 `cordis.yml`/Loader。
- browser 半：通过 `package.json` 的 `dsh.client` 声明 + `exports["./client"]` 被发现。
- 动态插件：`@deepseek-ai/dsh-tool-cordis` 的 `cordis_define`（plain JS 函数体，`kind:"new"|"existing"`）。

### 2.6 关键官方包（deepc 会依赖/参考）

`cordis`、`schemastery`、`cosmokit`（vendor）· `dsh-tools`（defineTool）·
`dsh-settings` / `dsh-settings-file`（配置子系统）· `dsh-storage` / `dsh-storage-json`（存储后端）·
`dsh-credentials-local`（凭据）· `dsh-client-connection`（连接层）· `dsh-api-gateway`（网关）·
`dsh-llm-deepseek`（模型适配器，参考其 Config 写法）· `dsh-invariants`（invariant companion）·
`dsh-base`（默认组合包）· **`dsh-client-ui-theme`（主题：`ThemeRuntime`/`theme.register`/`--dsw-alias-*`）** ·
`dsh-client-ui-settings`（设置壳 slot）· `dsh-client-ui-slots`（slot 注入）· `dsh-client-ui-layout`（`ThemePresenter`）。

### 2.7 官方文档路径（开发时按需查阅）

`docs/architecture.md(.zh)` · `docs/cordis-primer.md` · `docs/cordis-tutorial/01-first-plugin.md`、
`03-services.md` · `docs/cordis-api/registry.md` · `docs/user/develop/basic/{index,publish,tool}.md` ·
`docs/user/develop/framework/{index,service}.md` · `docs/subsystems/settings.md` ·
`docs/config-catalog.md` · `docs/tool-catalog.md` · `apps/cli/reference/README.md` ·
`apps/cli/composition.md` · `.agents/notes/proposed/architecture/2026-07-25-client-settings-locale-theme.md`。

### 2.8 符合三大特色的参考仓库/包

| 特色 | 官方参考 | 生态/外部参考 |
|------|----------|---------------|
| 主题 | `dsh-client-ui-theme`（`ThemeRuntime`/`theme.register`/`--dsw-alias-*`/`ui-theme.preference`） | 本站 `visual-architecture.md` 海洋 token（可 port 为 `abyss` 主题） |
| 插件管理 | `apps/cli/src/plugin.ts`、`docs/architecture.md`（profile/bundle）、Settings 分层笔记 | `imsai-sh/awesome-deepseek-harness-plugins`（dsh1024：异步 spawn + readInstalled + Settings 注入） |
| 多端互联 | `dsh-client-connection`（`IApiClient`）、WebSocket 下行载体笔记 | `werift` / `peerjs` / `simple-peer` / `trystero`；gist 自研（octokit.gists） |

## 3. deepc 整体架构

### 3.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ deepc 入口：dsh 插件（组合包）· 被 dsh plugin --profile web add deepc 安装   │
├────────────────────────────────────────────────────────────┤
│ 能力层（三个特色功能，各自独立组合包/服务）                    │
│   deepc-theme（主题）  deepc-plugins（管理）  deepc-peer（互联）│
├────────────────────────────────────────────────────────────┤
│ 底座层（共享服务，可被能力层 inject）                         │
│   settings（配置） storage（持久化） credentials（凭据）       │
│   security（映射白名单/动态路径/二次验证/审计）                │
├────────────────────────────────────────────────────────────┤
│ 运行环境：Cordis Context + dsh host + pnpm profile           │
└────────────────────────────────────────────────────────────┘
```

### 3.2 Cordis 服务图

```
ctx.settings ──┐
ctx.storage  ──┼──► deepc-theme   ──► ctx.theme.register + /theme-generate 导出
ctx.credentials ─► deepc-plugins ──► Settings slot 注入 + 异步 spawn + 清单读取
ctx.security ──► deepc-peer    ──► WebRTC DataChannel + 私有 gist 加密同步
```

- `ctx.security`（底座）：复用 `dsh-security-audit`——`~/.dsh/deepc/plugins/<id>/` 沙箱命名空间、
  `mappings.json` 白名单、动态临时路径、危险操作二次验证、`audit.log` 审计、安装前审计清单。
- `deepc-peer` 的加密密钥经 `ctx.security` 自协商派生，**密钥不出设备**。
- 三个能力插件**只依赖底座服务**，彼此解耦，可独立 `dsh plugin add`。

### 3.3 目录结构（deepc 仓库）

```
deepc/
├── package.json           # dsh.bundle 指向 cordis.patch.yml
├── cordis.patch.yml       # 组合包：按序挂载 deepc 各服务
├── src/
│   ├── index.ts           # 入口：组装底座 + 能力插件
│   ├── security/          # 映射/动态路径/二次验证/审计 + 密钥派生（security-audit 落地）
│   ├── theme/             # DeepcTheme 文档 + ctx.theme.register（local/remote）
│   ├── plugins/           # Settings 管理点注入 + 异步 spawn + 清单读取 + 更新提示
│   ├── peer/              # WebRTC DataChannel + 私有 gist 加密同步
│   └── settings/          # deepc 自身 ConfigSchema（schemastery）
└── README.md
```

### 3.4 配置（deepc 自身 namespace）

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  theme: z.string().default('abyss'),
  autoUpdate: z.boolean().default(false),
  peerEnabled: z.boolean().default(false),
  gistSync: z.boolean().default(true),   // 私有 gist 持久同步开关
  gistName: z.string().default('deepc-sync'),
  pairingTtl: z.number().step(1).min(30).max(600).default(120),
})
```

## 4. 与 deepSea 站点的关系

| 站点（deepSea / deepc.cn） | deepc（本地） |
|----------------|---------------|
| 主题构造器 `/theme-generate`（可视化编辑 + 导出） | `ctx.theme.register` 安装并生效主题 |
| 插件发现/收藏/评分 + 主题分享页 | 集中管理（Settings 注入）+ 状态上报 |
| 登录（OAuth）+ 统一同步面板 | WebRTC P2P + 私有 gist 加密同步 |
| 安全审计引导（`dsh-security-audit` 技能） | 本地执行审计 + 二次验证 |

**边界**：站点保持「无后端、octokit 直连」；deepc 只把「需要在本地执行/持久化」的部分下沉为插件，
站点与 deepc 之间通过「安装命令」与「WebRTC/私有 gist 同步」两条腿连接，**不新增中心化后端、
不要求用户 nginx 反代、业务数据只落在用户自己账号的密文里**。

## 5. 开发路线图

- [ ] **M2-底座**：deepc 组合包骨架 + `ctx.security`（映射白名单/动态路径/二次验证/审计 + 密钥派生）
- [ ] **M2-主题**：`DeepcTheme` 规范 + `ctx.theme.register` + 站点 `/theme-generate`（见 `-theme.md`）
- [ ] **M2-管理**：`ctx.plugins` + Settings 管理点注入 + 异步 spawn + 更新提示（见 `-plugin-management.md`）
- [ ] **M2-互联**：自协商加密 + 私有 gist 读写 + `ctx.peer` DataChannel（见 `-webrtc-interconnect.md`）
- [ ] **M3**：三能力端到端打通（主题跨端同步、对话同步、站点↔本地状态联动 + 主题分享页）

## 6. 完成标准（架构级）

- [ ] deepc 作为组合包可被 `dsh plugin --profile web add deepc` 安装、可被 `--dump-config` 看到独立层
- [ ] 底座服务（settings/storage/credentials/security）可被能力插件正确 `inject`
- [ ] 三个能力插件互不依赖、可独立卸载且不残留注册（Fiber dispose 语义）
- [ ] 所有写入走 `ctx.security` 白名单 + 二次验证，操作落 `audit.log`
- [ ] 同步数据一律端到端加密（密钥不出设备），私有 gist 只存密文
- [ ] 与站点通过「安装命令 + WebRTC/私有 gist 同步」连通，未引入任何中心化数据后端、不要求 nginx 反代
