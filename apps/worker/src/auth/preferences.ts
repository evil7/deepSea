// ---------------------------------------------------------------------------
// /auth/interconnect-log —— 互联日志读取（安全审计）
// /auth/preferences    —— 用户偏好读写（语言 / 主题 / 社区屏蔽，跨设备跟随账号）
//
//   · 互联日志：仅登录用户可查自己的日志（github_id 匹配）。
//   · 偏好：仅登录用户可读写自己的偏好；blocked_users 存 JSON 数组字符串。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import {
  getUserPreferences,
  listLogs,
  resolveSessionUserId,
  upsertUserPreferences,
} from "../lib/d1"

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

/** GET /auth/interconnect-log —— 返回登录用户最近的互联日志。 */
export async function handleInterconnectLog(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveSessionUserId(request, env)
  if (githubId === null) return json({ authed: false })

  const url = new URL(request.url)
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50))
  const rows = await listLogs(env, githubId, limit)
  return json({ authed: true, logs: rows })
}

/** 归一化偏好（D1 行 → API 结构；blocked_users JSON 容错解析）。 */
function mapPreferences(row: {
  language: string
  theme: string
  thumbs_down_threshold: number
  block_mode: string
  blocked_users: string
}) {
  let blockedUsers: string[] = []
  try {
    const parsed = JSON.parse(row.blocked_users)
    if (Array.isArray(parsed)) {
      blockedUsers = parsed.filter((u): u is string => typeof u === "string")
    }
  } catch {
    blockedUsers = []
  }
  const blockMode = row.block_mode === "hide" || row.block_mode === "off" ? row.block_mode : "collapse"
  return {
    language: row.language,
    theme: row.theme,
    thumbsDownThreshold: Math.max(0, Math.floor(row.thumbs_down_threshold)),
    blockMode,
    blockedUsers,
  }
}

/** GET /auth/preferences —— 返回登录用户偏好（无记录时返回默认空偏好）。 */
export async function handlePreferencesGet(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveSessionUserId(request, env)
  if (githubId === null) return json({ authed: false })

  const row = await getUserPreferences(env, githubId)
  if (!row) {
    return json({
      authed: true,
      preferences: {
        language: "",
        theme: "",
        thumbsDownThreshold: 0,
        blockMode: "collapse",
        blockedUsers: [],
      },
    })
  }
  return json({ authed: true, preferences: mapPreferences(row) })
}

/** PUT /auth/preferences —— 覆盖保存登录用户偏好。 */
export async function handlePreferencesPut(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveSessionUserId(request, env)
  if (githubId === null) return json({ authed: false })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ authed: true, ok: false, error: "invalid-json" }, 400)
  }

  const blockMode =
    body.blockMode === "hide" || body.blockMode === "off" ? body.blockMode : "collapse"
  const blockedUsers = Array.isArray(body.blockedUsers)
    ? (body.blockedUsers as unknown[]).filter((u): u is string => typeof u === "string")
    : []

  await upsertUserPreferences(env, {
    githubId,
    language: typeof body.language === "string" ? body.language.slice(0, 16) : "",
    theme: typeof body.theme === "string" ? body.theme.slice(0, 16) : "",
    thumbsDownThreshold:
      typeof body.thumbsDownThreshold === "number" && Number.isFinite(body.thumbsDownThreshold)
        ? Math.max(0, Math.floor(body.thumbsDownThreshold))
        : 0,
    blockMode,
    blockedUsers,
  })
  return json({ authed: true, ok: true })
}
