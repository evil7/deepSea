/**
 * deepSea 品牌 logo —— 唯一权威来源（与主站 `apps/web/public/deepsea.svg` 图案一致）。
 *
 * 集中一处定义，避免各处（悬浮球 / 鉴权页 / 远端 favicon）自行书写 SVG 导致样式漂移。
 * 含 `xmlns` 以便作为独立 favicon data URL 使用；内联 HTML 场景下 `xmlns` 被浏览器忽略，无害。
 * 默认显示尺寸 22×22（悬浮球/品牌图标场景）；鉴权页等大尺寸场景用 CSS 覆盖。
 */
export const DEEPSEA_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6.5" fill="#16b3eb"/><g transform="translate(4 4) scale(0.6667)" stroke="#02080f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12 q2.5 2 5 0 t5 0 t5 0 t5 0"/><path d="M2 19 q2.5 2 5 0 t5 0 t5 0 t5 0"/><path d="M2 5 q2.5 2 5 0 t5 0 t5 0 t5 0"/></g></svg>`
