// ---------------------------------------------------------------------------
// D1 数据访问层 —— 用户 / 会话 / deepc 偏好 / 互联日志
//
// 职责边界：D1 存「关系型用户数据」（users / sessions / deepc_preferences /
// interconnect_log）；账户档案（profile）直接用 GitHub 的，不在此重复。
// 临时口令信令（signal）与 OAuth state 仍在 KV（一次性 + 短 TTL 语义）。
// 用户 id 统一绑定 GitHub 数字 id（users.github_id 主键），所有数据以其关联。
//
// 敏感数据（token / 自定义加密 key）一律 AES-GCM 加密落库，解密仅在需要时进行。
// 时间戳统一毫秒（Date.now()），与现有 KV 口径一致。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys } from "./kv"
import { parseCookies } from "./cookies"

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

/** deepc 偏好行（theme 明文、encryption_key_enc 密文）。 */
export interface DeepcPreferencesRow {
  github_id: number
  theme: string | null
  encryption_key_enc: string | null
  updated_at: number
}

/** 互联日志行。 */
export interface InterconnectLogRow {
  id: number
  github_id: number | null
  event: string
  detail: string | null
  ip: string | null
  created_at: number
}

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
// deepc_preferences
// ---------------------------------------------------------------------------

/** 读 deepc 偏好（不存在返回 null；调用方按默认值兜底）。 */
export async function getPreferences(
  env: Env,
  githubId: number
): Promise<DeepcPreferencesRow | null> {
  return env.DEEPSEA_D1.prepare(
    "SELECT * FROM deepc_preferences WHERE github_id = ?"
  )
    .bind(githubId)
    .first<DeepcPreferencesRow>()
}

/**
 * upsert deepc 偏好。theme 明文；encryptionKey 由调用方传入**已加密**的
 * encryption_key_enc（Worker 不接触明文 key），可传 null 表示不更新该项。
 */
export async function upsertPreferences(
  env: Env,
  input: {
    githubId: number
    theme?: string | null
    encryptionKeyEnc?: string | null
  }
): Promise<void> {
  const now = Date.now()
  const current = await getPreferences(env, input.githubId)
  const theme =
    input.theme !== undefined ? input.theme : (current?.theme ?? null)
  const encKey =
    input.encryptionKeyEnc !== undefined
      ? input.encryptionKeyEnc
      : (current?.encryption_key_enc ?? null)
  await env.DEEPSEA_D1.prepare(
    `INSERT INTO deepc_preferences (github_id, theme, encryption_key_enc, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET
       theme = excluded.theme,
       encryption_key_enc = excluded.encryption_key_enc,
       updated_at = excluded.updated_at`
  )
    .bind(input.githubId, theme, encKey, now)
    .run()
}

// ---------------------------------------------------------------------------
// interconnect_log（互联日志：谁、何时、以何种方式连过本机 dsh）
// ---------------------------------------------------------------------------

/** 追加一条互联日志（githubId 可 null = 未登录临时口令连接）。 */
export async function appendLog(
  env: Env,
  input: {
    githubId: number | null
    event: string
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

/** 读某用户最近的互联日志（limit 条，倒序）。 */
export async function listLogs(
  env: Env,
  githubId: number,
  limit = 50
): Promise<InterconnectLogRow[]> {
  const result = await env.DEEPSEA_D1.prepare(
    `SELECT * FROM interconnect_log WHERE github_id = ?
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(githubId, limit)
    .all<InterconnectLogRow>()
  return result.results ?? []
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
