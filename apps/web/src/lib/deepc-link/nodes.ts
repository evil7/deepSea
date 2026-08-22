// ---------------------------------------------------------------------------
// deepc-link 设备节点 API —— 主站调 Worker `/auth/node/*`（同源 fetch + cookie）。
//
// 两类节点身份：
//   · Console（浏览器控制端）：以 GitHub 账号派生确定性 UUID（同账号 = 同 ID）。
//   · DSH node（本地插件端）：插件后端以主机 hostname 派生（同主机 = 同 ID）。
// 重复注册时 worker 仅 upsert（更新 name/last_seen），不创建新条目。
// ---------------------------------------------------------------------------

import { getOrCreateDrive } from "./device-fingerprint"

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

/**
 * 从 GitHub 账号 ID 派生确定性 console nodeId（UUID v4 格式）。
 * 同一账号在任意浏览器/设备登录 → 相同 nodeId → worker upsert 不重复创建。
 * 移除旧版 localStorage 随机 UUID 缓存（降级兼容）。
 */
async function deriveConsoleNodeId(githubId: string): Promise<string> {
  const encoded = new TextEncoder().encode(`deepsea-console-v1::${githubId}`)
  const hash = await crypto.subtle.digest("SHA-256", encoded)
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  // hex → UUID v4（8-4-4-4-12），与 worker NODE_ID_RE 正则兼容。
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-")
}

/** 清除旧版 localStorage 随机 UUID（迁移期一次性清理）。 */
function clearLegacyConsoleNodeId(): void {
  try {
    const legacy = localStorage.getItem(CONSOLE_NODE_KEY)
    if (legacy && legacy.includes("-")) {
      // 旧版是随机 UUID，新版是确定性派生 — 如果不匹配 deriveConsoleNodeId 则清除。
      // 注意：deriveConsoleNodeId 是 async，这里只做惰性清理，不影响功能。
    }
    // 不管怎样，新版不再需要这个 key。
    localStorage.removeItem(CONSOLE_NODE_KEY)
  } catch {
    // 忽略
  }
}

/**
 * 读取/生成主站控制端 nodeId。
 * 优先使用 GitHub 账号派生的确定性 ID（同账号 = 同设备身份）。
 * 降级：指纹 driveId（未登录时 / 极端情况）。
 */
export async function getOrCreateConsoleNodeId(githubId?: string): Promise<string> {
  clearLegacyConsoleNodeId()
  if (githubId) return deriveConsoleNodeId(githubId)
  // 降级：设备指纹 driveId（未登录场景理论上不应调此函数，但以防万一）。
  const { driveId } = await getOrCreateDrive()
  return driveId
}

/** Console 节点 name 前缀（区分 DSH 设备节点）。 */
const CONSOLE_NODE_PREFIX = "deepsea-console"

/** 判断是否为 console（浏览器控制端）节点。 */
export function isConsoleNode(node: NodeView): boolean {
  return node.name.startsWith(CONSOLE_NODE_PREFIX)
}

/**
 * 注册主站控制端节点。
 * @param githubId GitHub 账号数字 ID（`user.id`），用于派生确定性 nodeId。
 */
export async function registerConsoleNode(githubId: string): Promise<string> {
  const nodeId = await getOrCreateConsoleNodeId(githubId)
  // 名称使用统一前缀 + 浏览器标识，便于列表过滤和用户辨识。
  const device = (await getOrCreateDrive()).driveName
  await registerNode(nodeId, `${CONSOLE_NODE_PREFIX}:${device}`)
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
