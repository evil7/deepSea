// ---------------------------------------------------------------------------
// D1 数据访问层 —— 用户 / 会话 / 互联日志 / 设备令牌 / 隧道节点
//
// 职责边界：D1 存「关系型用户数据」（users / sessions / interconnect_log /
// deepc_device_tokens / deepc_tunnels）；账户档案（profile）直接用 GitHub 的。
// OAuth state 仍在 KV（一次性 + 短 TTL 语义）。
// 用户 id 统一绑定 GitHub 数字 id（users.github_id 主键），所有数据以其关联。
//
// 敏感数据（token）一律 AES-GCM 加密落库，解密仅在需要时进行。
// 时间戳统一毫秒（Date.now()），与现有 KV 口径一致。
//
// 注：deepc_nodes（设备注册表）/ deepc_config（配置同步）已随旧 P2P 架构退役删除。
// 新架构（TOTP 2FA + 匿名 Quick Tunnel）只纳管 URL，见 docs/deepsea-tunnel-bridge-proposal.md。
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
  /** 销毁标记（NULL=正常；非空=已销毁，24h 撤回窗口内） */
  destroyed_at: number | null
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

/** 审计事件码（与 migrations 字典一致）。 */
export type AuditEventCode =
  | "device_grant"
  | "tunnel_report"
  | "tunnel_delete"
  | "tunnel_access"

/** deepc 设备授权令牌行（只存 token 哈希）。 */
export interface DeepcDeviceTokenRow {
  token_hash: string
  github_id: number
  node_id: string | null
  created_at: number
  expires_at: number
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/** upsert 用户（登录回调时写；已存在则更新档案 + 换新 token）。
 *  重新登录即撤回销毁：ON CONFLICT 更新时清除 destroyed_at（24h 撤回窗口）。 */
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
       destroyed_at = NULL,
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

/**
 * 销毁账号（软删除，24h 内可撤回）：
 *   原子删除该用户全部关联数据（会话/设备令牌/隧道/偏好/日志），
 *   清空 token_enc（GitHub 访问失效）并标记 destroyed_at。
 *   保留 users 行作为撤回窗口标记；超时由 purgeDestroyedUsers 物理清理。
 * 注意：调用方需同时删除 KV user 缓存与当前会话（本函数只管 D1）。
 */
export async function destroyUserData(
  env: Env,
  githubId: number
): Promise<void> {
  const now = Date.now()
  await env.DEEPSEA_D1.batch([
    env.DEEPSEA_D1.prepare("DELETE FROM sessions WHERE github_id = ?").bind(githubId),
    env.DEEPSEA_D1.prepare("DELETE FROM deepc_device_tokens WHERE github_id = ?").bind(githubId),
    env.DEEPSEA_D1.prepare("DELETE FROM deepc_tunnels WHERE github_id = ?").bind(githubId),
    env.DEEPSEA_D1.prepare("DELETE FROM user_preferences WHERE github_id = ?").bind(githubId),
    env.DEEPSEA_D1.prepare("DELETE FROM interconnect_log WHERE github_id = ?").bind(githubId),
    env.DEEPSEA_D1.prepare(
      "UPDATE users SET destroyed_at = ?, token_enc = '', updated_at = ? WHERE github_id = ?"
    ).bind(now, now, githubId),
  ])
}

/**
 * 物理清理已销毁超时账号（24h 撤回窗口过后删除 users 行）。
 * 关联数据在 destroyUserData 时已删，此处仅删标记行。返回删除行数。
 */
export async function purgeDestroyedUsers(
  env: Env,
  cutoff: number
): Promise<number> {
  const res = await env.DEEPSEA_D1.prepare(
    "DELETE FROM users WHERE destroyed_at IS NOT NULL AND destroyed_at < ?"
  )
    .bind(cutoff)
    .run()
  return res.meta.changes ?? 0
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

// ---------------------------------------------------------------------------
// deepc_tunnels（远端互联节点，上报式）
// ---------------------------------------------------------------------------

export interface DeepcTunnelRow {
  node_id: string
  github_id: number
  node_name: string
  url: string | null
  status: string
  secret_hash: string | null
  created_at: number
  modified_at: number
}

/**
 * 上报节点（upsert，直接修改条目）：插件本地隧道启动后上报最新 URL。
 * 主站只纳管 URL，不存任何 secret（TOTP secret 由用户本地 2FA 管理）。
 * 节点不存在则创建（nodeId 由插件 hostname 派生，同主机 = 同 ID）；
 * 已存在则原地更新（node_id PK，防膨胀——不新增行）。
 */
export async function reportTunnel(
  env: Env,
  input: {
    nodeId: string
    githubId: number
    nodeName: string
    url: string
    /** 节点在线状态：connected（默认，上报即在线）/ offline（断链上报离线）。 */
    status?: "connected" | "offline"
    /**
     * sha512(TOTP secret)（免密直连开启时附带）。
     * ⚠️ 安全码跟随 dsh-node 而非 tunnel-URL：URL 变更（如 cloudflared
     * 临时链接到期重连）不应影响节点已绑定的安全码。因此缺省（未附 /
     * 关闭免密）时 **保留旧值**（COALESCE），只有附带新 hash（用户手动
     * 轮换 TOTP）时才更新。
     */
    secretHash?: string
  }
): Promise<void> {
  const now = Date.now()
  const status = input.status ?? "connected"
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO deepc_tunnels
       (node_id, github_id, node_name, url, status, secret_hash, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       node_name = excluded.node_name,
       url = excluded.url,
       status = excluded.status,
       secret_hash = COALESCE(excluded.secret_hash, deepc_tunnels.secret_hash),
       modified_at = excluded.modified_at`
  )
    .bind(
      input.nodeId,
      input.githubId,
      input.nodeName,
      input.url,
      status,
      input.secretHash ?? null,
      now,
      now,
    )
    .run()
}

/** 读节点行（归属校验：githubId 过滤；行存在即在线，无软删概念）。 */
export async function getTunnel(
  env: Env,
  nodeId: string,
  githubId: number
): Promise<DeepcTunnelRow | null> {
  return env.DEEPSEA_D1.prepare(
    "SELECT * FROM deepc_tunnels WHERE node_id = ? AND github_id = ?"
  )
    .bind(nodeId, githubId)
    .first<DeepcTunnelRow>()
}

/** 列出账号全部节点（前端 /link）。 */
export async function listTunnels(
  env: Env,
  githubId: number
): Promise<DeepcTunnelRow[]> {
  const res = await env.DEEPSEA_D1.prepare(
    `SELECT * FROM deepc_tunnels WHERE github_id = ?
     ORDER BY modified_at DESC`
  )
    .bind(githubId)
    .all<DeepcTunnelRow>()
  return res.results ?? []
}

/** 硬删节点（DELETE 行；防膨胀——不留软删残行）。 */
export async function deleteTunnel(
  env: Env,
  nodeId: string,
  githubId: number
): Promise<void> {
  await env.DEEPSEA_D1.prepare(
    "DELETE FROM deepc_tunnels WHERE node_id = ? AND github_id = ?"
  )
    .bind(nodeId, githubId)
    .run()
}

// ---------------------------------------------------------------------------
// user_preferences（用户偏好：语言 / 主题 / 社区屏蔽，跨设备跟随账号）
// ---------------------------------------------------------------------------

/** 用户偏好行。 */
export interface UserPreferencesRow {
  github_id: number
  language: string
  theme: string
  thumbs_down_threshold: number
  block_mode: string
  blocked_users: string
  updated_at: number
}

/** 偏好写入输入（blockedUsers 传数组，内部序列化 JSON）。 */
export interface UserPreferencesInput {
  githubId: number
  language: string
  theme: string
  thumbsDownThreshold: number
  blockMode: "collapse" | "hide" | "off"
  blockedUsers: string[]
}

/** upsert 用户偏好（不存在插入，存在整行覆盖）。 */
export async function upsertUserPreferences(
  env: Env,
  input: UserPreferencesInput
): Promise<void> {
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO user_preferences
       (github_id, language, theme, thumbs_down_threshold, block_mode, blocked_users, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET
       language = excluded.language,
       theme = excluded.theme,
       thumbs_down_threshold = excluded.thumbs_down_threshold,
       block_mode = excluded.block_mode,
       blocked_users = excluded.blocked_users,
       updated_at = excluded.updated_at`
  )
    .bind(
      input.githubId,
      input.language,
      input.theme,
      Math.max(0, Math.floor(input.thumbsDownThreshold)),
      input.blockMode,
      JSON.stringify(input.blockedUsers),
      Date.now()
    )
    .run()
}

/** 读用户偏好（不存在返回 null）。 */
export async function getUserPreferences(
  env: Env,
  githubId: number
): Promise<UserPreferencesRow | null> {
  return env.DEEPSEA_D1.prepare(
    "SELECT * FROM user_preferences WHERE github_id = ?"
  )
    .bind(githubId)
    .first<UserPreferencesRow>()
}
