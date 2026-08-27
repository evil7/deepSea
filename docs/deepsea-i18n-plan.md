# deepSea i18n 国际化规划（zh-CN / en-US）

> 目标：web 主站（`apps/web`）+ deepc-link 插件（`packages/deepc-link` 浏览器端 UI）全覆盖中英双语，
> 采用 React 标准 i18n 方案（react-i18next），JSON 文案文件按项目分别集中存放、便于统一修改。

---

## 1. 范围与边界

| 面 | 覆盖 | 不覆盖 |
| --- | --- | --- |
| **web**（`apps/web`） | 全部页面/组件 UI 文案、SEO meta、toast/错误提示、date-fns 语言包、`<html lang>` | 静态资源、URL 结构（保持单 URL 客户端切换） |
| **plugin**（`packages/deepc-link/src/client`） | host-ui 悬浮球+Sheet、目录选择器、文件查看器、monkey-patch 提示 | node 端（3081 代理/cloudflared/TOTP）纯逻辑无 UI；console 日志保持原文 |
| **worker**（`apps/worker`） | — | 保持返回**机器可读错误码**（`rate-limited` / `not-found` 等），**不在 worker 翻译**；错误文案由前端按码映射 i18n |

> 边界约定：worker 侧新增错误一律用稳定 code，中文/英文文案只出现在前端 i18n 资源里。
> 现状已符合（`index.ts` 返回 `{ ok:false, error:"rate-limited" }` 等），维持契约即可。

---

## 2. 现状盘点（硬编码字符串分布）

grep 摸底约 **250 条** UI 文案（`zh-CN` 为当前唯一语言）：

| 位置 | 文件 | 约条数 | 特点 |
| --- | --- | --- | --- |
| web 页面 | `pages/*.tsx`（7 页） | ~100 | 含 toast、placeholder、aria-label、状态文案 |
| web 组件 | `components/layout/topbar.tsx` 等 | ~40 | 导航菜单、主题按钮、用户卡 |
| web 组件 | `components/showcase/ocean-conf.ts` + `sea-debug-panel.tsx` | ~45 | 海洋调试面板（浪高/密度/视角等）——低频但量大 |
| web 组件 | `components/home/*` | ~20 | 首页各屏标语、特性卡 |
| web lib | `lib/github/discussions.ts`、`App.tsx` SEO | ~25 | 社区标签、路由级 SEO title/description |
| plugin | `client/host-ui/index.ts` | ~30 | 悬浮球 + Sheet 三模式 UI、2FA 绑定 |
| plugin | `client/directory-picker.ts` | ~10 | 目录选择器（错误/占位/按钮） |
| plugin | `client/file-viewer.ts`、`host-ui/components.ts`、`hooks.ts` | ~8 | 查看器、复制提示、连接状态 |

---

## 3. 技术选型

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 核心库 | **i18next** + **react-i18next**（React 标准 i18n 组件） | `useTranslation` hook / `<Trans>` 组件 / 插值 / 复数（en 需要 plural） |
| 语言检测 | **i18next-browser-languagedetector**（仅 web） | web 用 localStorage + navigator；plugin 不自行检测，跟随 dsh 配置的语言选项（`locale.preference`，见 §5） |
| 语言 | `zh-CN`（默认/回退）、`en-US` | 现状为中文站，zh-CN 作 fallback 不破坏既有体验 |
| JSON 资源 | 各项目内 `src/**/i18n/locales/<lang>.json`（每语言 1 个文件） | esbuild / Vite 原生支持 JSON import |
| 类型安全 | react-i18next `CustomTypeOptions` 以 zh-CN JSON 生成 key 类型 | key 拼错编译期报错（见 §6） |
| date-fns | `date-fns/locale` 的 `zhCN` / `enUS` 联动切换 | web 现有 `formatDistanceToNow` 等 |

**为什么 plugin 也能用 react-i18next**：plugin browser 端是 esbuild 独立 bundle（`scripts/build.mjs`），
`react`/`react-dom` 走 external 由 dsh 前端提供，而 **i18next/react-i18next 纯 JS 无副作用 import，直接打进 bundle**——
不依赖 dsh 官方前端是否自带 i18n，自包含最稳。react-i18next v15+ 兼容 React 19。

**依赖清单**：
- web：`i18next` `react-i18next` `i18next-browser-languagedetector`
- plugin：`i18next` `react-i18next`（打进 bundle，不进 dependencies，放 devDependencies 即可）
- 两项目 tsconfig 均需 `resolveJsonModule: true`（当前均为 `moduleResolution: "bundler"`，JSON import 走 `tsc` 类型检查需显式开启）

---

## 4. 文件布局（各自项目内统一集中 · 每语言 1 个文件）

> 按你的要求：web 与 plugin 各自维护一套 JSON，且**每种语言只保留 1 个文件**（`zh-CN.json` / `en-US.json`），
> 不再按模块拆命名空间。key 用点分层模拟分段（如 `nav.home`、`errors.rateLimited`），改文案只动 JSON、不碰代码。

```
apps/web/src/i18n/
├── index.ts                  # i18n 初始化（detector + resources + 类型）
├── resources.ts              # import 两个 JSON → resources（单一来源）
└── locales/
    ├── zh-CN.json            # 全站中文（唯一中文文件，按点号分段）
    └── en-US.json            # 全站英文（完整镜像）
packages/deepc-link/src/client/i18n/
├── index.ts                  # 同步初始化（initImmediate:false）+ 读 dsh locale.preference
└── locales/
    ├── zh-CN.json            # 插件中文（悬浮球+Sheet / 目录选择器 / 文件查看器）
    └── en-US.json            # 插件英文（完整镜像）
```

单文件内部以**顶级分段 key** 组织，对应原模块划分：

```jsonc
// apps/web/src/i18n/locales/zh-CN.json（示意）
{
  "common": { "loading": "加载中…", "copy": "复制" },
  "nav":    { "home": "生态概览", "theme": "切换到深色" },
  "home":   { "hero": "万物皆插件" },
  "plugins": { "search": "直接输入即过滤缓存渔获…" },
  "plugin": { "noDesc": "暂无描述" },
  "community": { "search": "搜索标题或作者…" },
  "communityDetail": { "replyPlaceholder": "且慢，我有话要说…" },
  "links":  { "online": "在线" },
  "device": { "authorizing": "授权中…" },
  "seo":    { "homeTitle": "deepSea · DeepSeek Harness 插件生态社区" },
  "errors": { "rateLimited": "触发 GitHub 限流，请稍后再试" }
}
```

对应英文文件保持**同一棵树**（镜像），QA 可整体校对。

> 取舍：单文件省去了多命名空间的管理/加载成本，代价是文件体积增大（预计 zh 全站 300~400 行、en 同量级）。
> 纯客户端同步加载（`useSuspense:false` + JSON 随包）无懒加载诉求，单文件完全够用；
> 若未来文案膨胀到数千条再考虑按需切片。

---

## 5. 语言检测与切换

### web（浏览器主站）
- 检测顺序：`?lang=` 查询参数 → `localStorage['deepsea.lang']` → `navigator.language` → `zh-CN`
- **语言切换器位置**：navbar（顶栏）右侧，**明暗切换按钮（Sun/Moon）旁边**——Globe 图标按钮，点击弹出 zh / EN 两项，切换即 `i18n.changeLanguage()` + 持久化。与主题按钮保持同一尺寸/风格（`variant="ghost" size="icon"`），紧邻排列
- `languageChanged` 事件同步 `document.documentElement.lang`（SEO/无障碍）
- `useSuspense: false`：首页首屏不因翻译资源异步加载而闪烁/挂起（JSON 已随包打包，本就同步可得）

### plugin（dsh 浏览器端注入）
- **跟随 dsh 配置的语言选项自适应**：语言取 dsh 设置的 `locale.preference`（`settings` 命名空间），不自行检测 navigator / localStorage，不设语言切换 UI
- 获取路径：经 `settingsScope` 的 describe mirror（或 `connection.api.settings.get('locale.preference')` RPC）读取；dsh 语言值映射为 `zh-CN` / `en-US`，未知值回退 `zh-CN`
  - dsh 官方通用设置（语言/外观/Enter）远端可用（不依赖 `settings.describe` RPC 的特权项），3081 远端模式也能读到
  - 监听 dsh 设置变更事件：用户改语言 → 插件 i18n 即时跟随
- 同步初始化（`initImmediate: false`）：host-ui 用 `createRoot` 在 dsh 运行时挂载，等不起异步 init 竞态；初始化在 apply 时先读 `locale.preference` 再 boot host-ui
- 兜底：`locale.preference` 缺失/读不到时回退 `zh-CN`（当前站与插件默认中文，不破坏既有体验）

---

## 6. 类型安全（key 防错）

两项目各自声明：

```ts
// apps/web/src/i18n/resources.ts
import zhCN from "./locales/zh-CN.json"
import enUS from "./locales/en-US.json"

export const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
} as const

// 全局类型增强（.d.ts）：以 zh-CN 资源树约束 key
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation"
    resources: (typeof resources)["zh-CN"]
  }
}
```

效果：`t("links.onlin")` 编译报错；en-US 缺 key 由 QA 脚本/`saveMissing` 兜底检测。
plugin 侧同样模式（`src/client/i18n/index.ts`）。

---

## 7. date-fns 语言包联动

web 现有 `date-fns` 用量（帖子时间、仓库创建时间等）。封装一个 hook：

```ts
// apps/web/src/hooks/use-fmt.ts
import { zhCN, enUS } from "date-fns/locale"
export function useFmt() {
  const { i18n } = useTranslation()
  const locale = i18n.language.startsWith("zh") ? zhCN : enUS
  return { locale, formatDistanceToNow, format } // 或直接把 locale 传给调用点
}
```

注意 `date-fns/locale` 的 `zhCN` 与 `enUS` 都是命名导出（v4），直接映射无需额外依赖。

---

## 8. SEO 与 `<html lang>`

- `App.tsx` 的 `seoForPath()`：title/description 全部改走 `t("seo:...")`，key 内插 `{{owner}}/{{repo}}/{{number}}`
- `usePageMeta` 已由路由层驱动，语言切换后 title 自动刷新（依赖数组含 i18n.language 或重跑 seoForPath）
- `document.documentElement.lang` 同步（`index.html` 静态 `lang="zh-CN"` 作无 JS 兜底）
- **SEO 说明**：纯客户端 i18n = 单 URL 双语，爬虫只索引默认语言（zh-CN）。若后续要英文站 SEO，再加 `?lang=en-US` 参数化 URL + `hreflang` alternate——**本期不做**，仅记录。

---

## 9. 实施阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0 脚手架** | 装依赖；两 tsconfig 加 `resolveJsonModule`；建 `i18n/` 目录与 `index.ts`/`resources.ts`；写 `zh-CN.json` 骨架（含分段）；navbar 明暗按钮旁加语言切换器；`html lang` 联动 | 切语言 zh↔en 全站即时生效（文案仍缺，显示 key 占位） |
| **P1 web 主路径** | topbar/nav、home、plugins、plugin-detail、links、device-login、community 两页迁移 + `errors` 段 toast 映射 | 上述页面中英双语完整，无残留硬编码 |
| **P2 web 长尾** | SEO meta（`seo` 段）、date-fns 联动、ocean-conf 调试面板、`lib/github/discussions.ts` 社区标签 | 全站 0 硬编码（grep 复查）；`?lang=` 生效 |
| **P3 plugin** | host-ui（悬浮球+Sheet）、directory-picker、file-viewer、monkey-patch 提示 → 各自 i18n；同步 init + 读 dsh `locale.preference` 自适应 + 监听设置变更 | 插件在 dsh 任意语言设置（zh/en）下正确显示并随设置变更即时切换；esbuild 打包通过 |
| **P4 收尾** | en-US 全量校对（重点：插件三模式/2FA 术语）；缺 key 检测脚本；`tsc` 类型检查 + 双端 build；bundle 体积确认 | `pnpm typecheck` / `build` 绿；en-US 无缺漏 |

---

## 10. 风险与注意点

| 风险 | 对策 |
| --- | --- |
| plugin bundle 体积 +~40KB（i18next ~40KB + react-i18next ~12KB） | 打进 bundle 可接受（<5%）；不引 detector，JSON 随包；如后续体积敏感可改 external + dsh 前端提供 |
| plugin host-ui 是 `React.createElement` 风格（无 JSX） | `useTranslation` 是标准 hook，与渲染风格无关，直接可用；`<Trans>` 组件不适用处用 `t()` 插值即可 |
| `resolveJsonModule` 未开导致 `tsc` 报 JSON import | P0 统一加；Vite/esbuild 运行时不依赖该 flag，仅类型检查需要 |
| en 复数（`1 item` vs `2 items`） | 用 i18next `_one`/`_other` 复数 key；zh 无复数直接单条 |
| 动态文案（`{{name}}`、`{{count}}`） | 全部走 `t()` 插值，禁止模板字符串拼中文 |
| worker 返回的少量中文 | 现状为 code，维持；若发现新中文返回立即改为 code（见 §1 边界） |
| 语言切换后已挂载组件不刷新 | react-i18next v15 自动重渲染；非 React 的模块级常量（如 `menuItems`）改为 hook/`t()` 内联 |
| `seoForPath` 在路由层模块级执行 | 改为组件内 `useMemo(() => seoForPath(pathname), [pathname, i18n.language])` |

---

## 11. 快速开始（P0 落地示例）

```bash
# web
pnpm --filter @deepsea/web add i18next react-i18next i18next-browser-languagedetector

# plugin（打进 bundle，放 devDependencies）
pnpm --filter deepc-link add -D i18next react-i18next
```

```ts
// apps/web/src/i18n/index.ts（示意）
import i18n from "i18next"
import LanguageDetector from "i18next-browser-languagedetector"
import { initReactI18next } from "react-i18next"
import { resources } from "./resources"

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    detection: {
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      lookupLocalStorage: "deepsea.lang",
    },
    // 每语言单文件：i18next 默认命名空间即 "translation"，无需配置 defaultNS；
    // key 直接用点号全路径（如 t("nav.home")）
    react: { useSuspense: false },
    interpolation: { escapeValue: false },
  })

export default i18n
```

---

## 12. 结语

- 一套 react-i18next 标准方案同时覆盖 web 与 plugin 两个 React 面；每语言只维护 1 个 JSON（`zh-CN.json` / `en-US.json`），路径约定统一，改文案零代码接触。
- 分期落地（P0 脚手架 → P1/P2 web → P3 plugin → P4 收尾），每期可独立验证，避免一次性大迁移回归。
- 长期维护约定：**新文案一律写进 JSON 再引用**，worker 不产文案，en-US 镜像同步补。
