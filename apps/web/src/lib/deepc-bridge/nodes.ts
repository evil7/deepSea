// ---------------------------------------------------------------------------
// deepc-bridge 设备节点 API —— 主站调 Worker `/auth/node/*`（同源 fetch + cookie）。
//
// 设备注册/列表/心跳/删除。信令（offer/answer）走 /ws/signal（DO 信号房），
// 不再经 HTTP 信箱。主站列表展示 + 点卡片直连（WS 投递 offer）。
// ---------------------------------------------------------------------------

export interface NodeView {
  nodeId: string
  name: string
  lastSeen: number | null
  online: boolean
  createdAt: number
}

async function authFetch<T>(url: string, init?: RequestInit): Promise<T | null> {
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

/** 列出当前登录账号的所有设备（含在线状态）。 */
export async function listNodes(): Promise<NodeView[]> {
  const data = await authFetch<{ authed?: boolean; nodes?: NodeView[] }>("/auth/node/list")
  if (!data?.authed || !Array.isArray(data.nodes)) return []
  return data.nodes
}

/** 注册/更新设备（插件端调用；主站一般只读列表）。 */
export async function registerNode(nodeId: string, name: string): Promise<boolean> {
  const data = await authFetch<{ ok?: boolean }>("/auth/node/register", {
    method: "POST",
    body: JSON.stringify({ nodeId, name }),
  })
  return data?.ok === true
}

/** 删除设备（吊销）。 */
export async function removeNode(nodeId: string): Promise<boolean> {
  const data = await authFetch<{ ok?: boolean }>("/auth/node/remove", {
    method: "POST",
    body: JSON.stringify({ nodeId }),
  })
  return data?.ok === true
}

// ---------------------------------------------------------------------------
// 主站控制端节点（多端直连发起方；answer 经 WS 回投）
// ---------------------------------------------------------------------------

const CONSOLE_NODE_KEY = "deepsea:consoleNodeId"

/** 读取/生成主站控制端 nodeId（localStorage 持久化，answer 经 WS 回投）。 */
export function getOrCreateConsoleNodeId(): string {
  try {
    const existing = localStorage.getItem(CONSOLE_NODE_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    localStorage.setItem(CONSOLE_NODE_KEY, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

/** 注册主站控制端节点（登录后调用，使 worker 归属校验认可该 nodeId）。 */
export async function registerConsoleNode(): Promise<string> {
  const nodeId = getOrCreateConsoleNodeId()
  await registerNode(nodeId, "sonar-console")
  return nodeId
}

/** 信箱信封（与插件端 node-signaling.ts 严格对齐）。 */
export interface NodeEnvelope {
  from: string
  v: 1
  sdp: string
}

export function encodeNodeEnvelope(from: string, sdp: string): string {
  return JSON.stringify({ from, v: 1, sdp })
}

export function decodeNodeEnvelope(raw: string): NodeEnvelope | null {
  try {
    const obj = JSON.parse(raw) as Partial<NodeEnvelope>
    if (
      typeof obj.from !== "string" ||
      obj.from.length === 0 ||
      obj.v !== 1 ||
      typeof obj.sdp !== "string" ||
      obj.sdp.length === 0
    ) {
      return null
    }
    return { from: obj.from, v: 1, sdp: obj.sdp }
  } catch {
    return null
  }
}
