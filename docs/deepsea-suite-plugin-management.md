# 深海套装 · 插件集中管理（线上线下 + 本地管理点注入）

> 状态：**规划中（M2）** · 所属：深海套装（DEEPSEA KIT）特色能力之一
> 编写：2026-08-19（第二轮细化）· 关联文档：`deepsea-suite-deepc-architecture.md`（整体架构）

## 1. 定位与目标

把散落在「线上（GitHub 生态）」与「线下（本地 profile）」的 dsh 插件**集中管理**，并把管理
界面**注入到 dsh 本体**（本地管理点），让用户不离开 dsh 就能安装/卸载/更新/审计插件与主题。

- **线上**：延续 deepSea 的插件发现（`dsh-plugin-discovery`）与安装引导（`dsh-issue-bridge`），
  提供评分、收藏、一键安装。
- **线下**：deepc 在 dsh 内注入「插件管理」设置页，统一管理多 profile 的插件清单、版本、更新、审计。
- **统一设置页**：**插件与主题共用一个管理设置页**（主题也是插件），避免两套管理入口。
- **后续**：站点新增「主题分享页」，汇聚各用户提交的优秀主题（可一键应用/移植）。

## 2. 官方调查结论（本地插件管理的真实入口 + 管理点注入方式）

经核对 `deepseek-ai/deepseek-harness` 与生态 `imsai-sh/awesome-deepseek-harness-plugins`：

- **插件管理 = `dsh plugin` 命令**（`apps/cli/src/plugin.ts`）：转发 pnpm
  （`add`/`remove`/`update`/`why`…），成功后按已安装状态对账 `dsh.profile.bundles`。
- **管理点注入（Settings 功能属主自注册）**：dsh 的设置面板是「纯组合面」——Settings 壳只声明
  slot，不枚举任何功能；每个功能由**自己的插件向对应 slot 注册**（官方笔记
  `2026-07-25-client-settings-locale-theme.md`：`ui-theme` 向 `settings.general.item` 注册 Appearance 行）。
  → deepc 的管理页 = **注册进 Settings 的 section / item slot**。
- **生态范式（dsh1024 的 in-app store）**：`dsh1024` 的 store 出现在**三个入口**——sidebar footer
  （带 live catalog 计数）、Settings 导航、`Settings → Plugins` tab；它通过本地 HTTP routes
  读取/写 profile，并用 `spawn` 调官方 CLI。
- **⚠️ 关键工程约束**：**必须用异步 `spawn`，绝不 `spawnSync`**（会冻结 harness 事件循环）。
  dsh1024 的 `install-runner` 用 `spawn` + 64KB 滚动缓冲 + 5 分钟 timeout；CLI 前缀
  `npx --yes @deepseek-ai/dsh`，插件内复用运行中的 dsh entry。
- **清单读取**：`readInstalled(profile)` / `readProfileState(dshHome, profile)` 直接读 profile 目录
  的 `package.json` 依赖，识别 npm spec 与 `github:` spec；`inspectInstallation` 对比安装前后。

> 结论：deepc 的「线下管理」是 **dsh1024 式**：注入 Settings 管理页 → 异步 spawn 官方 CLI →
> 读 profile 清单还原状态，**不自己造注册表、不 spawnSync**。

## 3. 数据模型

### 3.1 线上（deepSea 站点）

- 复用 `lib/github/search.ts` + `PLUGIN_SEED_URL` 种子（Actions 同步，零配额）。
- 收藏/关注 + 安装状态标记（本地 deepc 上报已装插件 id）。

### 3.2 线下（deepc 本地）

```
~/.dsh/
├── profiles/
│   └── <name>/
│       ├── package.json          # 依赖 + dsh.profile.bundles
│       ├── pnpm-lock.yaml
│       └── cordis.patch.yml      # 用户自己的 patch 层
└── deepc/
    ├── mappings.json             # 插件 → 沙箱路径白名单（复用 security-audit）
    ├── favorites.json            # 收藏同步缓存
    ├── themes.json               # local/remote 主题定义（见主题文档）
    └── audit.log                 # 安装/更新/卸载审计
```

插件清单项（deepc 内部统一模型，主题也作为一类插件管理）：

```ts
interface ManagedPlugin {
  id: string            // owner/repo 或 npm 名
  source: 'github' | 'npm' | 'local' | 'theme'
  version?: string      // 当前安装版本
  latest?: string       // 最新 release/tag
  hasBundle: boolean    // 是否声明 dsh.bundle
  profile: string       // 所属 profile
  installedAt: string
  updateAvailable?: boolean
}
```

## 4. deepc 管理插件架构

- **服务**：`ctx.plugins`（Cordis service），暴露 `list/install/remove/update/inspect`。
- **后端执行**：`spawn('npx', ['--yes', '@deepseek-ai/dsh', 'plugin', '--profile', profile, action, target])`
  或复用运行中的 dsh entry（见 dsh1024 `install-runner`）；**绝不 spawnSync**。
- **清单读取**：解析 profile 目录 `package.json`（依赖 + `dsh.profile.bundles`）+ lockfile。
- **更新提示**：`octokit.repos.listReleases` 对比最新 tag（复用 issue-bridge 的 release 对比）。
- **安全审计**：安装/更新前走 `dsh-security-audit` 清单（来源可信、依赖高危、license、dry-run）。

```ts
export const name = 'deepc-plugins'
export const inject = ['storage', 'settings', 'slots']

export function apply(ctx: Context) {
  // 本地管理点注入：注册到 Settings 的 Plugins section
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'deepc-plugins',
    order: 20,
    // ...渲染插件+主题统一管理面板
  }))

  ctx.plugins.register({
    list: (profile) => readProfilePlugins(profile),
    install: (spec) => spawnDsh('add', spec),   // 异步 spawn，捕获进度
    remove: (spec) => spawnDsh('remove', spec),
    update: () => spawnDsh('update'),
    inspect: (id) => inspectPlugin(id),
  })
}
```

## 5. 线上线下联动流程

```
deepSea 站点（线上）                 deepc（线下，dsh 内设置页）
─────────────                    ─────────────
搜索/发现插件 ── 一键安装 ──►  dsh plugin add <owner>/<repo>
收藏/评分 ───── 收藏同步 ◄──  favorites.json 上报
主题分享页 ───── 主题同步 ◄──  themes.json（local/remote）
已装状态 ◄───── 状态上报 ──  list() 读 profile 清单
更新提示 ◄───── release 对比 ─  update() / inspect()
```

- 站点「在 deepc 中安装」：检测到本地 deepc 运行（见互联文档）→ 直接 RPC 执行安装；
  否则给复制命令。
- 状态上报走多端互联（WebRTC P2P / 私有 gist），实现「打开站点即知本地装了什么」。

## 6. 里程碑与完成标准

- [ ] M2-1：`ctx.plugins` 服务 + 清单读取（package.json + lockfile 解析）
- [ ] M2-2：异步 spawn 安装/卸载/更新（不用 spawnSync）+ 审计日志
- [ ] M2-3：Settings 本地管理点注入（插件+主题统一设置页）
- [ ] M2-4：更新提示与站点「已装/有新版本」徽标
- [ ] M2-5：线上↔线下收藏/状态/主题同步
- [ ] M2-6：站点「主题分享页」（用户提交优秀主题，一键应用/移植）

## 7. 参考

- 官方 CLI 插件管理：`apps/cli/src/plugin.ts`、`apps/cli/reference/README.md`
- 官方 Settings 分层：`.agents/notes/proposed/architecture/2026-07-25-client-settings-locale-theme.md`
- 官方 profile/bundle：`docs/architecture.md`（Profiles and bundles）
- **生态范式**：`imsai-sh/awesome-deepseek-harness-plugins`（`packages/dsh1024` 的
  `install-runner` 异步 spawn、`readInstalled`/`readProfileState`、Settings slot 注入）
- 本站已有能力：技能 `dsh-plugin-discovery` / `dsh-issue-bridge` / `dsh-security-audit`
