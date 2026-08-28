// ---------------------------------------------------------------------------
// deepc-link 隧道节点 API —— 主站调 Worker `/auth/tunnel/*`（同源 fetch + cookie）。
//
// 三模式（见 docs/deepsea-tunnel-bridge-proposal.md）：
//   1. local   本地域内共享（插件 3081 TOTP 2FA，无需主站）
//   2. tunnel  CF Tunnel 暴露（匿名 Quick Tunnel / 自定义域，无需主站）
//   3. managed 主站纳管：登录后插件上报最新 URL，主站仅纳管 URL。
//
// 主站只纳管 URL，不存任何 secret（TOTP secret 由用户本地 2FA 应用管理）。
// 数据面不走 Worker —— 本模块只做管理面（列表 / 删除）。
// ---------------------------------------------------------------------------

export interface TunnelNodeView {
  nodeId: string
  name: string
  status: string
  url: string
  /** 最近修改时间（Worker 返回 modified_at：上报/改名均刷新）。 */
  lastSeen: number | null
  createdAt: number
}

/** 主站签发的一次性 ticket（后台免密直连 bypass）。 */
export interface TunnelTicket {
  nodeId: string
  ts: number
  nonce: string
  sig: string
}

async function authFetch<T>(
  url: string,
  init?: RequestInit
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...init,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** 列出当前账号隧道节点（前端 /links 卡片列表）。 */
export async function listTunnels(): Promise<TunnelNodeView[]> {
  const data = await authFetch<{ ok?: boolean; nodes?: TunnelNodeView[] }>(
    "/auth/tunnel/list",
  )
  const nodes = data?.nodes ?? []
  // 有纳管节点 → 标记「已使用 links」（star/follow 引导卡片据此展示）
  if (nodes.length > 0) {
    try {
      localStorage.setItem(HAS_NODES_KEY, "1")
    } catch {
      /* ignore */
    }
  }
  return nodes
}

/** localStorage 键：账号存在纳管节点（StarFollowGuide 展示前提之一）。 */
export const HAS_NODES_KEY = "deepsea:has-nodes"

/** 删除隧道节点（D1 硬删；tunnel 是插件本地 Quick Tunnel，无需 CF API）。 */
export async function deleteTunnel(nodeId: string): Promise<boolean> {
  const data = await authFetch<{ ok?: boolean }>("/auth/tunnel/delete", {
    method: "POST",
    body: JSON.stringify({ nodeId }),
  })
  return data?.ok === true
}

/**
 * 请求后台免密直连（bypass）：主站签发一次性 ticket。
 * 成功返回 { url, ticket }；失败（未启用 bypass / 无权限 / 未登录）返回 null，
 * 前端回退到「新窗口打开 + 手动输 TOTP」。
 */
export async function requestAccess(
  nodeId: string
): Promise<{ url: string; ticket: TunnelTicket } | null> {
  const data = await authFetch<{
    ok?: boolean
    url?: string
    ticket?: TunnelTicket
  }>("/auth/tunnel/access", {
    method: "POST",
    body: JSON.stringify({ nodeId }),
  })
  if (!data?.ok || !data.url || !data.ticket) return null
  return { url: data.url, ticket: data.ticket }
}
