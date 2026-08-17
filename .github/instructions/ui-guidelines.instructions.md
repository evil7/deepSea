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

## 组件编写要点

- 函数组件 + hooks；props 使用 TypeScript 类型定义。
- 优先复用 `ui/` 中已有组件（`Button`、`Card`、`Dialog`、`Badge` 等），避免重复造轮子。
- 无障碍：交互元素保留语义标签与键盘可用性（shadcn 的 Radix 组件默认已满足）。
