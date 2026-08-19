# 深海套装 · 主题一致性方案（local / remote）

> 状态：**规划中（M2）** · 所属：深海套装（DEEPSEA KIT）特色能力之一
> 编写：2026-08-19（第二轮细化）· 关联文档：`deepsea-suite-deepc-architecture.md`（整体架构）

## 1. 定位与目标

用一套**一致的主题方案**统一多端视觉：同一个主题，桌面端、移动端、远程浏览器一致呈现；
同时把「主题」从一次性的颜色配置升级为**可创造、可调整、可导出、可同步、可移植**的社区资产。

- **用户视角**：在站点可视化捏一套深海主题 → 本地 dsh 立即生效 → 其它设备自动同步 → 也可分享给他人。
- **产品视角**：主题是深海套装的门面，也是后续「社区主题分享页」的内容来源。
- **开发者视角**：**约定并规范化一个主题模板与框架概念**，分为 **local（本地）** 与
  **remote（远端）** 两类，都落在官方 `ui-theme` 注册机制之上，而不是另起炉灶。

## 2. 官方调查结论（主题在 dsh 里到底长什么样）

经核对 `deepseek-ai/deepseek-harness` 源码，**dsh 的主题机制是 `@deepseek-ai/dsh-client-ui-theme`
这一插件，而非「一个 settings namespace」**。关键事实如下：

- **`ThemeRuntime`（`ctx.theme`）**：持有实时主题偏好 `light / dark / system`（默认 `system`），
  用 `prefers-color-scheme` 解析 `system`，发布**不可变 `ThemeSnapshot`** 并通过 `theme/change`
  事件通知。它**绝不碰 DOM**——由 `ui-layout` 的 `ThemePresenter` 应用解析后的快照：
  `html { color-scheme }`、`body[data-ds-dark-theme]`、主题别名 token 的内联 CSS 变量、
  `meta[name="theme-color"]`。
- **第三方主题注册**：`theme.register({ id, colorScheme, tokens })`（`ThemeDefinition`）。
  `tokens` 是 **`--dsw-alias-*` 别名层的覆盖**，且**必须同时提供 light + dark 双模式**
  （`ThemeTokenModes`：`{ light: string, dark: string }`），保证切主题时不会不可读。
- **token 体系**：`--dsw-static-*`（静态尺度色阶，`design-platform.css`：amber/blue/neutral/red 等）
  + `--dsw-alias-*`（语义别名层：`--dsw-alias-bg` / `--dsw-alias-fg` / `--dsw-alias-bg-base` /
  `--dsw-alias-bg-layer-2` / `--dsw-alias-bg-overlay` / `--dsw-alias-border-l1` / `--dsw-alias-scrollbar-*`）。
- **持久化**：官方只持久化**三态偏好** `ui-theme.preference`（`ThemeSettingsSchema`，
  仅存 `preference`，写入 `$DSH_HOME/settings.yaml`）。

> ⚠️ 两条硬限制（deepc 必须自己解，也是「一致性方案」存在的理由）：
> 1. **第三方注册的主题 id 是进程内扩展**——不跨内置偏好边界，重启即失；
> 2. **远程浏览器无法访问 privileged settings API**——远端选择是 process-local，不能直接写回偏好。

### 2.1 结论

deepc 主题 = **local/remote 双层框架**，都建立在官方 `theme.register()` 之上：

| 层 | 含义 | 落地方式 |
|----|------|----------|
| **local** | 本地主题：直接调用 `ctx.theme.register()`，把优秀主题的 token 映射到 `--dsw-alias-*` | 进程内注册，重启由 deepc 重新注册 |
| **remote** | 远端主题：主题定义（token 覆盖）经 P2P/gist 同步到各端，各端落地注册 | 见 `deepsea-suite-webrtc-interconnect.md` 的 `config` 通道 |

## 3. 主题模板与框架（要约定的规范）

把主题定义成一个**可移植的 JSON 文档**（这是「约定」的核心），再映射到 `ThemeDefinition`：

```ts
/** deepc 主题文档（local 与 remote 共用的唯一真源） */
interface DeepcTheme {
  id: string                    // 主题 id（如 'abyss'、'kelp-forest'）
  name: string                  // 展示名
  base: 'light' | 'dark'        // 基础调色板
  /** --dsw-alias-* 别名层覆盖；缺省项回落到 base 调色板默认值 */
  tokens: Record<string, { light: string; dark: string }>
  /** 元数据：作者 / 版本 / 许可 / 来源（port 自哪个主题） */
  meta: { author: string; version: string; source?: string }
}
```

**local 落地（移植优秀主题）**：其它主题（如 Catppuccin、Nord、GitHub 主题，或本站海洋 token）
统一映射到 `--dsw-alias-*` 命名空间：

```ts
export const name = 'deepc-theme'
export const inject = ['theme']

export function apply(ctx: Context) {
  // 把 DeepcTheme 翻译成官方 ThemeDefinition 注册为进程内主题
  const themes: DeepcTheme[] = loadLocalThemes()
  for (const t of themes) {
    ctx.theme.register({
      id: t.id,
      colorScheme: t.base,
      tokens: expandToBothModes(t.tokens), // { '--dsw-alias-bg': {light, dark}, ... }
    })
  }
}
```

> 注意：官方 `register` 的 `tokens` 是「别名覆盖」而非全量定义，未覆盖的别名自动回落内置调色板；
> 因此移植一个主题**只需声明差异 token**，无需搬运整套 `--dsw-static-*`。

## 4. 站点侧：`theme-generate` 页面

新增路由 **`/theme-generate`**：可视化创造、调整、导出主题配置。

1. **创造**：取色器 + 滑块编辑 `--dsw-alias-*` 别名 token（light/dark 双模式预览切换）。
2. **调整**：实时预览在 dsh 风格 UI 上的效果（复用 deepSea 现有 `ocean-conf.ts` 参数面板范式）。
3. **导出**：
   - 导出 `DeepcTheme` JSON（可导入、可分享）；
   - 生成 `deepc theme apply <json>` 或一键「应用到本地 dsh」；
   - 生成 deepc 主题插件骨架（遵循官方 `dsh.bundle`，供 `dsh plugin add` 安装）。
4. **导入/移植**：粘贴优秀主题的 token JSON，自动映射到 `--dsw-alias-*`。

## 5. 多端一致性（local ↔ remote 联动）

- **本地统一主题设置**：deepc 在 dsh 的设置页（`settings.general.item` slot，见插件管理文档）
  注入「主题」行，列出 local 主题 + remote 同步来的主题，选择即 `theme.setTheme(id)`。
- **远端同步**：主题定义（`DeepcTheme` 文档）通过多端互联的 `config` 通道 / 私有 gist
  （端到端加密）同步到各端；各端 deepc 收到后 `register` 落地（见互联文档）。

## 6. 里程碑与完成标准

- [ ] M2-1：定义 `DeepcTheme` 主题文档规范 + `--dsw-alias-*` 别名清单
- [ ] M2-2：`ctx.theme.register` 落地 local 主题 + 移植 1 个优秀主题验证映射
- [ ] M2-3：站点 `/theme-generate` 页面（创造 → 调整 → 导出 JSON/骨架）
- [ ] M2-4：local ↔ remote 主题同步（端到端）
- [ ] M2-5：主题导入/导出/分享闭环 + 社区主题分享页（见插件管理文档）

## 7. 参考

- 官方主题插件：`packages/client/ui-theme`（`ThemeRuntime` / `ThemeDefinition` /
  `theme.register` / `--dsw-alias-*` / `ui-theme.preference`）
- 官方主题呈现器：`packages/client/ui-layout/src/client/theme-presenter.ts`（DOM 应用）
- 官方主题分层笔记：`.agents/notes/proposed/architecture/2026-07-25-client-settings-locale-theme.md`
- 官方打包规范：`docs/user/develop/basic/publish.md`（`dsh.bundle` + `cordis.patch.yml`）
- 本站海洋 token：仓库记忆 `visual-architecture.md`（作为第一个可移植的 `abyss` 主题来源）
