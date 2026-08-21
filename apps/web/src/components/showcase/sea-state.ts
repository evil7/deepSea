// ---------------------------------------------------------------------------
// 海洋状态（统一动画驱动）
//   surface —— 海面（首页 hero 屏）：镜头在海面上方
//   deep    —— 深海（万物皆插件/插件精选/社区/套装屏 + 所有二级功能页）：
//              镜头潜入海底
// 由 点击（探索更多）、滚动（首页翻屏）、路由（功能页/回首页）共同驱动，
// Ocean 组件只响应该状态做平滑下潜/上浮动画，保证所有路径动画一致。
// ---------------------------------------------------------------------------

export type SeaState = "surface" | "deep"

/** 首页第几屏开始视为「深海」（万物皆插件屏；首页第二屏即下潜） */
export const DEEP_SLIDE_INDEX = 1

/** 首页各屏 id（Topbar 菜单 / Features 卡片 / home.tsx slides 数组共用）。
 *  取消 hash 定位后，站内跳转改用 location.state 携带 slideId 精准定位。 */
export const HOME_SLIDE_IDS = {
  ecosystem: "dsh-ecosystem",
  curated: "dsh-curated",
  community: "dsh-community",
  deepseaKit: "dsh-deepsea-kit",
} as const
