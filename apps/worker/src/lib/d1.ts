// ---------------------------------------------------------------------------
// D1 数据访问层 —— 用户 / 会话 / 互联日志 / 设备
//
// 职责边界：D1 存「关系型用户数据」（users / sessions / interconnect_log /
// deepc_nodes / deepc_device_tokens）；账户档案（profile）直接用 GitHub 的，不在此重复。
// 信箱信令（nodeSignal）与 OAuth state 仍在 KV（一次性 + 短 TTL 语义）。
// 配置（deepc_config）已迁回 D1（WS+DO 方案：D1 存储 + DO 推送 config-changed 通知）。
// 用户 id 统一绑定 GitHub 数字 id（users.github_id 主键），所有数据以其关联。
//
// 敏感数据（token）一律 AES-GCM 加密落库，解密仅在需要时进行。
// 时间戳统一毫秒（Date.now()），与现有 KV 口径一致。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys } from "./kv"
import { parseCookies } from "./cookies"
import { sha256Hex } from "./crypto"

/** 用户档案行（与 me.ts 返回的 AuthUser 对齐，token_enc 为密文）。 */
export interface UserRow {
  github_id: number
  login: string
  email: string | null
  avatar_url: string
  name: string | null
  bio: string | null
  html_url: string
  followers: number
  following: number
  public_repos: number
  token_enc: string
  created_at: number
  updated_at: number
}

/** 插入/更新的用户档案输入（token_enc 已加密）。 */
export interface UpsertUserInput {
  githubId: number
  login: string
  email: string | null
  avatar_url: string
  name: string | null
  bio: string | null
  html_url: string
  followers: number
  following: number
  public_repos: number
  tokenEnc: string
}

/** 会话行。 */
export interface SessionRow {
  id: string
  github_id: number
  created_at: number
  expires_at: number
  last_seen: number | null
  user_agent: string | null
  ip: string | null
}

/** 互联日志行。 */
export interface InterconnectLogRow {
  id: number
  github_id: number | null
  event: string
  detail: string | null
  ip: string | null
  created_at: number
  /** 事件说明（listLogs 时 LEFT JOIN audit_event_types 填充）。 */
  description?: string | null
}

/** 审计事件码（与 migrations/0007_audit_events.sql 字典一致）。 */
export type AuditEventCode =
  | "device_grant"
  | "device_register"
  | "device_revoke"
  | "config_put"

/** deepc 设备 node 行（多端互联设备注册表）。 */
export interface DeepcNodeRow {
  node_id: string
  github_id: number
  name: string
  last_seen: number | null
  created_at: number
  updated_at: number
}

/** deepc 设备授权令牌行（只存 token 哈希）。 */
export interface DeepcDeviceTokenRow {
  token_hash: string
  github_id: number
  node_id: string | null
  created_at: number
  expires_at: number
}

/** deepc 配置行（账号级 key-value，跨端配置同步）。 */
export interface DeepcConfigRow {
  github_id: number
  key: string
  value: string
  node_id: string | null
  updated_at: number
}

/** 配置键名校验：字母数字开头，后续可含 . _ -，长度 1-64。 */
export const CONFIG_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/** upsert 用户（登录回调时写；已存在则更新档案 + 换新 token）。 */
export async function upsertUser(
  env: Env,
  input: UpsertUserInput
): Promise<void> {
  const now = Date.now()
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO users
       (github_id, login, email, avatar_url, name, bio, html_url,
        followers, following, public_repos, token_enc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET
       login = excluded.login,
       email = excluded.email,
       avatar_url = excluded.avatar_url,
       name = excluded.name,
       bio = excluded.bio,
       html_url = excluded.html_url,
       followers = excluded.followers,
       following = excluded.following,
       public_repos = excluded.public_repos,
       token_enc = excluded.token_enc,
       updated_at = excluded.updated_at`
  )
    .bind(
      input.githubId,
      input.login,
      input.email,
      input.avatar_url,
      input.name,
      input.bio,
      input.html_url,
      input.followers,
      input.following,
      input.public_repos,
      input.tokenEnc,
      now,
      now
    )
    .run()
}

/** 读用户（返回 null 表示不存在）。 */
export async function getUser(
  env: Env,
  githubId: number
): Promise<UserRow | null> {
  return env.DEEPSEA_D1.prepare(
    "SELECT * FROM users WHERE github_id = ?"
  )
    .bind(githubId)
    .first<UserRow>()
}

/** 删除用户（token 失效清理时）。 */
export async function deleteUser(env: Env, githubId: number): Promise<void> {
  await env.DEEPSEA_D1.prepare("DELETE FROM users WHERE github_id = ?")
    .bind(githubId)
    .run()
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/** 创建会话（登录回调时写；P1 双写，KV session 仍保留）。 */
export async function createSession(
  env: Env,
  input: {
    id: string
    githubId: number
    expiresAt: number
    userAgent: string | null
    ip: string | null
  }
): Promise<void> {
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO sessions (id, github_id, created_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      input.githubId,
      Date.now(),
      input.expiresAt,
      input.userAgent,
      input.ip
    )
    .run()
}

/** 读会话（返回 null 表示不存在或已过期）。 */
export async function getSession(
  env: Env,
  id: string
): Promise<SessionRow | null> {
  const row = await env.DEEPSEA_D1.prepare(
    "SELECT * FROM sessions WHERE id = ?"
  )
    .bind(id)
    .first<SessionRow>()
  if (!row) return null
  if (row.expires_at <= Date.now()) return null
  return row
}

/** 删除会话（登出 / token 失效清理）。 */
export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DEEPSEA_D1.prepare("DELETE FROM sessions WHERE id = ?")
    .bind(id)
    .run()
}

/** 删除某用户的所有会话（token 失效时多端下线）。 */
export async function deleteUserSessions(
  env: Env,
  githubId: number
): Promise<void> {
  await env.DEEPSEA_D1.prepare("DELETE FROM sessions WHERE github_id = ?")
    .bind(githubId)
    .run()
}

// ---------------------------------------------------------------------------
// interconnect_log（互联日志：谁、何时、以何种方式连过本机 dsh）
// ---------------------------------------------------------------------------

/** 追加一条互联日志（githubId 可 null；event 用字典短码）。 */
export async function appendLog(
  env: Env,
  input: {
    githubId: number | null
    event: AuditEventCode
    detail?: string | null
    ip?: string | null
  }
): Promise<void> {
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO interconnect_log (github_id, event, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      input.githubId,
      input.event,
      input.detail ?? null,
      input.ip ?? null,
      Date.now()
    )
    .run()
}

/** 读某用户最近的互联日志（limit 条，倒序，join 字典表补说明）。 */
export async function listLogs(
  env: Env,
  githubId: number,
  limit = 50
): Promise<InterconnectLogRow[]> {
  const result = await env.DEEPSEA_D1.prepare(
    `SELECT l.*, e.description
     FROM interconnect_log l
     LEFT JOIN audit_event_types e ON e.code = l.event
     WHERE l.github_id = ?
     ORDER BY l.created_at DESC LIMIT ?`
  )
    .bind(githubId, limit)
    .all<InterconnectLogRow>()
  return result.results ?? []
}

/** 清除 cutoff（毫秒）之前的互联日志（30 天 Cron 调用）。 */
export async function purgeLogs(
  env: Env,
  cutoff: number
): Promise<number> {
  const result = await env.DEEPSEA_D1.prepare(
    "DELETE FROM interconnect_log WHERE created_at < ?"
  )
    .bind(cutoff)
    .run()
  return result.meta.changes ?? 0
}

// ---------------------------------------------------------------------------
// deepc_nodes（多端设备注册表）
// ---------------------------------------------------------------------------

/** upsert 设备（注册 / 心跳 / 改名统一入口）。 */
export async function upsertNode(
  env: Env,
  input: {
    nodeId: string
    githubId: number
    name: string
  }
): Promise<void> {
  const now = Date.now()
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO deepc_nodes (node_id, github_id, name, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       name = excluded.name,
       last_seen = excluded.last_seen,
       updated_at = excluded.updated_at`
  )
    .bind(input.nodeId, input.githubId, input.name, now, now, now)
    .run()
}

/** 读单个设备（归属校验：node_id + github_id 同时匹配）。 */
export async function getNode(
  env: Env,
  nodeId: string,
  githubId: number
): Promise<DeepcNodeRow | null> {
  return env.DEEPSEA_D1.prepare(
    "SELECT * FROM deepc_nodes WHERE node_id = ? AND github_id = ?"
  )
    .bind(nodeId, githubId)
    .first<DeepcNodeRow>()
}

/** 列出某账号全部设备（按 last_seen 倒序，在线的靠前）。 */
export async function listNodes(
  env: Env,
  githubId: number
): Promise<DeepcNodeRow[]> {
  const result = await env.DEEPSEA_D1.prepare(
    `SELECT * FROM deepc_nodes WHERE github_id = ?
     ORDER BY last_seen DESC`
  )
    .bind(githubId)
    .all<DeepcNodeRow>()
  return result.results ?? []
}

/** 统计某账号已登记的节点数（配额校验用）。 */
export async function countNodesByGithub(
  env: Env,
  githubId: number
): Promise<number> {
  const row = await env.DEEPSEA_D1.prepare(
    "SELECT COUNT(*) AS cnt FROM deepc_nodes WHERE github_id = ?"
  )
    .bind(githubId)
    .first<{ cnt: number }>()
  return row?.cnt ?? 0
}

/** 删除设备（吊销，下线）。 */
export async function removeNode(
  env: Env,
  nodeId: string,
  githubId: number
): Promise<boolean> {
  const result = await env.DEEPSEA_D1.prepare(
    "DELETE FROM deepc_nodes WHERE node_id = ? AND github_id = ?"
  )
    .bind(nodeId, githubId)
    .run()
  return result.meta.changes > 0
}

// ---------------------------------------------------------------------------
// deepc_device_tokens（设备授权令牌，只存 SHA-256 哈希）
// ---------------------------------------------------------------------------

/** 签发设备令牌（存哈希，不落明文）。 */
export async function createDeviceToken(
  env: Env,
  input: {
    tokenHash: string
    githubId: number
    nodeId: string | null
    expiresAt: number
  }
): Promise<void> {
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO deepc_device_tokens (token_hash, github_id, node_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(input.tokenHash, input.githubId, input.nodeId, Date.now(), input.expiresAt)
    .run()
}

/** 按哈希读令牌（未过期才返回；过期返回 null）。 */
export async function getDeviceToken(
  env: Env,
  tokenHash: string
): Promise<DeepcDeviceTokenRow | null> {
  const row = await env.DEEPSEA_D1.prepare(
    "SELECT * FROM deepc_device_tokens WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first<DeepcDeviceTokenRow>()
  if (!row) return null
  if (row.expires_at <= Date.now()) return null
  return row
}

/** 吊销某设备的所有令牌（设备删除时调用）。 */
export async function revokeDeviceTokensByNode(
  env: Env,
  nodeId: string
): Promise<void> {
  await env.DEEPSEA_D1.prepare(
    "DELETE FROM deepc_device_tokens WHERE node_id = ?"
  )
    .bind(nodeId)
    .run()
}

// ---------------------------------------------------------------------------
// deepc_config（账号级配置同步）
// ---------------------------------------------------------------------------

/** 读单条配置（无返回 null）。 */
export async function getConfig(
  env: Env,
  githubId: number,
  key: string
): Promise<DeepcConfigRow | null> {
  return env.DEEPSEA_D1.prepare(
    "SELECT * FROM deepc_config WHERE github_id = ? AND key = ?"
  )
    .bind(githubId, key)
    .first<DeepcConfigRow>()
}

/** 增量列出配置（updated_at > since，走 idx_config_github 索引，无变更读 0 行）。 */
export async function listConfig(
  env: Env,
  githubId: number,
  since = 0
): Promise<DeepcConfigRow[]> {
  const result = await env.DEEPSEA_D1.prepare(
    `SELECT * FROM deepc_config WHERE github_id = ? AND updated_at > ?
     ORDER BY updated_at ASC`
  )
    .bind(githubId, since)
    .all<DeepcConfigRow>()
  return result.results ?? []
}

/**
 * 写配置（LWW + 单调递增时间戳）：updated_at = max(now, 现有 + 1)。
 * 返回最终写入的 updated_at。
 */
export async function putConfig(
  env: Env,
  input: {
    githubId: number
    key: string
    value: string
    nodeId: string | null
  }
): Promise<number> {
  const now = Date.now()
  const existing = await env.DEEPSEA_D1.prepare(
    "SELECT updated_at FROM deepc_config WHERE github_id = ? AND key = ?"
  )
    .bind(input.githubId, input.key)
    .first<{ updated_at: number }>()
  const updatedAt = Math.max(now, (existing?.updated_at ?? 0) + 1)
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO deepc_config (github_id, key, value, node_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(github_id, key) DO UPDATE SET
       value = excluded.value,
       node_id = excluded.node_id,
       updated_at = excluded.updated_at`
  )
    .bind(input.githubId, input.key, input.value, input.nodeId, updatedAt)
    .run()
  return updatedAt
}

// ---------------------------------------------------------------------------
// 会话解析（公共）
// ---------------------------------------------------------------------------

/**
 * 从请求 cookie 解析登录用户 githubId（D1 优先，回退 KV；P1 双写过渡）。
 * 未登录 / 会话失效返回 null。供 me.ts / preferences.ts 等复用。
 */
export async function resolveSessionUserId(
  request: Request,
  env: Env
): Promise<number | null> {
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]
  if (!sessionId) return null

  const d1Session = await getSession(env, sessionId)
  if (d1Session) return d1Session.github_id

  const raw = await env.DEEPSEA_KV.get(kvKeys.session(sessionId))
  if (!raw) return null
  try {
    return Number((JSON.parse(raw) as { userId: string }).userId)
  } catch {
    return null
  }
}

/**
 * 从 device_token 字符串解析登录用户 githubId（token 只存 SHA-256 哈希）。
 * 供「非 header 传递 token」的场景（如 WS 建连 query/subprotocol）复用。
 */
export async function resolveDeviceUserIdFromToken(
  token: string,
  env: Env
): Promise<number | null> {
  if (!token) return null
  const hash = await sha256Hex(token)
  const row = await getDeviceToken(env, hash)
  return row?.github_id ?? null
}

/**
 * 从 Authorization: Bearer <device_token> 解析登录用户 githubId。
 * 插件端（127.0.0.1:3080）无 cookie，经 Device Grant 流换取 device_token 后，
 * 用此函数校验。token 只存 SHA-256 哈希，校验时对请求 token 哈希后查表。
 */
export async function resolveDeviceUserId(
  request: Request,
  env: Env
): Promise<number | null> {
  const auth = request.headers.get("Authorization")
  if (!auth?.startsWith("Bearer ")) return null
  const token = auth.slice("Bearer ".length).trim()
  return resolveDeviceUserIdFromToken(token, env)
}

/**
 * 解析「登录用户 githubId」：cookie session 优先，回退 device_token（Bearer）。
 * 供 node 端点复用 —— 主站用 cookie，插件端用 device_token，同一套归属校验。
 */
export async function resolveActorUserId(
  request: Request,
  env: Env
): Promise<number | null> {
  const sessionId = await resolveSessionUserId(request, env)
  if (sessionId !== null) return sessionId
  return resolveDeviceUserId(request, env)
}
