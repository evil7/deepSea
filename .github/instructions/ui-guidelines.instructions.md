---
description: "Use when 编写 React 组件、使用 shadcn/ui、Tailwind 类名、主题与暗色模式、animejs 动效、组件结构。covers UI 开发规范。"
name: "shadcn/ui 与样式规范"
applyTo: ["apps/web/src/**"]
---

# shadcn/ui 与样式规范

## 硬性规则

1. **`src/components/ui/**` 由 shadcn CLI 管理，禁止手改**。需要新组件时：
   ```bash
   pnpm --filter @deepsea/web dlx shadcn add <name>
   ```
2. 业务组件放 `src/components/<feature>/`，页面组件放 `src/pages/`，不要在页面里堆砌大量内联 UI。
3. 类名合并统一使用 `cn()`（来自 `@/lib/utils`），禁止手工模板字符串拼接条件类名。
4. 颜色一律走设计令牌（`bg-primary`、`text-muted-foreground` 等），**禁止硬编码色值**；自定义色值先加到 `src/index.css` 的 `@theme`。
5. 间距/圆角/字号优先使用 Tailwind 预设（`p-4`、`rounded-lg`、`text-sm`），避免魔数。

## 主题

- 项目使用 CSS 变量主题 + `dark` 类切换（见 `theme-provider.tsx`），新组件必须同时考虑暗色模式。
- 样式写在 `index.css` 的 `:root` 与 `.dark` 变量中，组件内只引用变量。

## 动效（animejs）

- animejs **仅用于展示 / 落地页**（hero、介绍动画、页面过渡）。
- 业务界面（列表、表单、对话框）用 shadcn/Tailwind 的过渡即可，避免过度动效影响操作效率。
- 动效组件放 `src/components/showcase/`，与业务组件隔离。

### animejs v4 关键坑（务必遵守）

- **缓动参数名是 `ease`，不是 `easing`**（v4 改名）。写 `easing:` 会被静默忽略、动画退化为线性。
- 缓动字符串：`"easeOutExpo"`、`"easeInOutCubic"`、`"outExpo"`、弹性 `"outElastic(1, 0.55)"`、回弹 `"outBack(2.5)"`。
- **动画结束后要清除 inline 样式**：`onComplete: () => { el.style.transform = ""; el.style.opacity = "" }`。
  残留的 `transform` 会创建新的 containing block，**使子元素的 `position: sticky` 失效**（实测踩坑）。
- v4 默认用 WAAPI，不在元素上写中间态 inline style；采样动画需在动画进行中读 `style`/`getComputedStyle`。

### 场景过渡动画（showcase 分工）

| Hook | 触发时机 | 用途 |
| ---- | ---- | ---- |
| `usePageEnter`（`components/showcase/page-enter.ts`） | 页面挂载（一次性） | 子页面进入上浮+淡入；`useLayoutEffect` 先设初始态防闪烁 |
| `useSlideReveal`（`components/showcase/slide-reveal.ts`） | 进入视口（可重复） | 首页全屏板块标题/卡片 stagger 上浮 |

- 子页面（`/plugins` `/plugin/:o/:r` `/community` `/community/:n`）根容器统一挂 `usePageEnter`。

### sticky 失效两坑（务必遵守）

1. 残留 inline `transform` 会破坏 sticky（见上）。
2. **sticky 元素不能包在「高度 = 自身」的父容器里**（如 `div.relative` 只包 header、sentinel 用 absolute 不占流），
   否则吸附空间为零。必须让 sticky 元素与 sentinel 平级（返回 Fragment），父容器 = 整个页面容器。

## 共享页头 PageHeader（`components/layout/page-header.tsx`）

- 四个子页面统一页头（面包屑 / 标题 / 描述 / 操作区），杜绝各自手写字号/间距不一致。
- Props：`title`（统一 `text-2xl`）/ `description` / `actions` / `breadcrumb` / `sticky` / `showTopButton`。
- **sticky 变形**：滚动后吸附 topbar（`h-16=64px`）之下 `sticky top-16 z-20`，由「标题+描述（多行）」
  压缩为「标题+操作（单行）」：breadcrumb/description 隐藏、标题 `text-2xl→text-base+truncate`。
- stuck 检测：sentinel（`h-px`，与 header 平级）+ IntersectionObserver（`rootMargin: -64px`）。
- **`showTopButton`（默认 true）**：sticky 状态在操作区最右显示 `[↑ Top]`，animejs 数值动画平滑滚动到顶。
- **眉题规范**：`03 · COMMUNITY` 这类序号眉题**仅用于首页 showcase 板块**，子页面页头不显示。

## 配色自适应 autoColor（社区页）

- 纯函数 `lib/theme/auto-color.ts`：`extractThemeColors(data, w, h) → { primary, secondary, accent }`（hex）。
  - **量化 16 色桶**：12 彩色（色相每 30°）+ 4 灰阶（黑/深灰/灰/白，按明度）。
  - **权重偏向彩色**：`weight = S × (1 - |V - 0.5| × 2)` —— 饱和度加权 + 明度中段三角，压低黑白/大面积低饱和背景。
  - **选举三色**：得分最高 → primary（饱和度增强到 0.6）；secondary = 与 primary 色相距离 ≥ 2 桶（60°）的对比色，
    否则 primary 浅变体；accent = 第三对比色或 primary 深变体。保证三色不撞色系。
- Hook `hooks/use-auto-color.ts`：`useImageThemeColor(src)` —— 加载 `<img>` → 缩到 100×100 canvas → 提取。
- **组件可配置三色**：手动三色常量兜底（`COMMUNITY_THEME`），autoColor 失败时回退；`AUTO_COLOR` 开关。
- 注入 CSS 变量 `--theme-primary / --theme-secondary / --theme-accent` 到页面根容器，组件用
  `var(--theme-*)` 或 `custom.css` 语义类（`.text-theme` `.bg-theme-soft` `.border-theme-soft`
  `.text-theme-accent` `.community-dot-grid` 点阵纹理）自适应，避免硬编码 cyan/amber。
- 分类徽章/色条保留 6 色分类语义（不随主题变），仅「身份徽章/分类激活/按钮/hover/点阵」跟随主题。

## Tailwind v4 语法要点

- 渐变：`bg-linear-to-*`（v4 已改名，非 `bg-gradient-to-*`）。
- CSS 变量简写：`text-(--theme-primary)`（非 `text-[var(--theme-primary)]`）。
- 负 inset：`inset-[-3%]`（非 `-inset-[3%]`）。
- 透明变体用 `color-mix(in srgb, var(--x) N%, transparent)`（custom.css 内定义语义类）。


## 组件编写要点

- 函数组件 + hooks；props 使用 TypeScript 类型定义。
- 优先复用 `ui/` 中已有组件（`Button`、`Card`、`Dialog`、`Badge` 等），避免重复造轮子。
- 无障碍：交互元素保留语义标签与键盘可用性（shadcn 的 Radix 组件默认已满足）。
