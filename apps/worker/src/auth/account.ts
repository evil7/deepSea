// ---------------------------------------------------------------------------
// POST /auth/account/destroy —— 销毁 deepSea 账号（软删除，24h 内可撤回）
//   校验登录会话 → 原子删除全部关联数据（会话/设备令牌/隧道/偏好/日志）
//   + 清空 GitHub token + 清 KV 缓存 → 标记 destroyed_at（撤回窗口）。
//   撤回：24h 内重新走 GitHub OAuth 登录（callback upsertUser 清 destroyed_at）。
//   超时：Cron 每日 purgeDestroyedUsers 物理清理 users 行。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { SESSION_COOKIE, kvKeys } from "../lib/kv"
import { expireCookie, parseCookies } from "../lib/cookies"
import { getClientIp } from "../lib/ratelimit"
import {
  appendLog,
  destroyUserData,
  resolveSessionUserId,
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

/** POST /auth/account/destroy —— 销毁当前登录账号（软删除 + 清数据）。 */
export async function handleAccountDestroy(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveSessionUserId(request, env)
  if (githubId === null) return json({ authed: false }, 401)

  // 1. D1：原子删除关联数据 + 标记销毁 + 清空 token
  await destroyUserData(env, githubId)

  // 2. KV：删除 user 缓存（token 缓存失效）与当前会话
  const cookies = parseCookies(request.headers.get("Cookie"))
  const sessionId = cookies[SESSION_COOKIE]
  if (sessionId) {
    await env.DEEPSEA_KV.delete(kvKeys.session(sessionId))
  }
  await env.DEEPSEA_KV.delete(kvKeys.user(String(githubId)))

  // 3. 审计：销毁账号（web 端用户操作事件；此时关联日志已清空，
  //    本行独立保留——24h 撤回窗口内 /auth/me 仍返回 destroyed 状态）
  await appendLog(env, {
    githubId,
    event: "account_destroy",
    ip: getClientIp(request),
  })

  // 3. 过期会话 cookie（前端据此回到未登录态）
  const destroyedAt = Date.now()
  const headers = new Headers(json({ ok: true, destroyedAt }).headers)
  headers.set("Set-Cookie", expireCookie(SESSION_COOKIE))
  return new Response(JSON.stringify({ ok: true, destroyedAt }), {
    status: 200,
    headers,
  })
}
