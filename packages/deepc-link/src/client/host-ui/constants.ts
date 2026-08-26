/**
 * host-ui 常量与环境判定。
 */

/** 后端控制路由基址（与 host.ts 的 NODE_CTRL_PATH 一致；同源 3080）。 */
export const DEEPC_CTRL_BASE = '/deepc'

/** 悬浮球 + sheet + 触发热区根节点 id（幂等守卫 + CSS 锚点）。 */
export const HOST_ZONE_ID = '__deepc_bridge_zone'
export const FAB_ID = '__deepc_bridge_fab'
export const SHEET_ID = '__deepc_bridge_sheet'
export const TRIGGER_ID = '__deepc_bridge_trigger'
export const HOST_UI_STYLE_ID = '__deepc_bridge_style'

/** 是否 loopback 访问（本地 dsh：显示完整配置卡片；远端：仅显示时长+断开单行）。 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

/** dsh 官方前端监听端口（origin port）。 */
export const DSH_ORIGIN_PORT = '3080'

/**
 * 官方本地直连判定：仅当 loopback 且端口为官方 origin（3080）才算「本地面板」。
 * 经 3081 鉴权代理 / 隧道域名访问一律视为远端（只显示 connect_time + 断开单行）。
 */
export function isOfficialLocalOrigin(): boolean {
  const { hostname, port } = window.location
  return isLoopbackHost(hostname) && port === DSH_ORIGIN_PORT
}

/** 域守卫：远端快照/非本地 dsh 上下文不注入（防双角色死循环）。 */
export function isRemoteContext(): boolean {
  const { hostname, port } = window.location
  return hostname === 'sonar-landing-page.deepc.cn' || port === '8789'
}
