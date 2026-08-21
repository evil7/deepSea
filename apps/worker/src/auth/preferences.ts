// ---------------------------------------------------------------------------
// /auth/interconnect-log —— 互联日志读取（安全审计）
//
//   · 互联日志：仅登录用户可查自己的日志（github_id 匹配）。
//   · 配置同步（theme / model / 偏好）见 auth/config.ts（D1 存储 + DO 推送，
//     已从 gist 迁回）。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { listLogs, resolveSessionUserId } from "../lib/d1"

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
