// ---------------------------------------------------------------------------
// /auth/preferences —— deepc 偏好读写（自定义加密 key / 主题）
// /auth/interconnect-log —— 互联日志读取
//
//   · 需有效登录会话（cookie）—— 账户档案用 GitHub，这里只管 deepc 自身偏好。
//   · 加密 key 处理：前端传入明文 key，Worker 用 TOKEN_ENC_KEY 派生的 AES 密钥
//     加密后落 D1（encryption_key_enc），读时解密返回明文（仅会话有效）。与
//     token 的处理口径一致：落库为密文，Worker 瞬时处理明文。
//   · 互联日志：仅登录用户可查自己的日志（github_id 匹配）。
// ---------------------------------------------------------------------------

import type { Env } from "../index"
import { decryptToken, encryptToken } from "../lib/crypto"
import {
  getPreferences,
  listLogs,
  resolveSessionUserId,
  upsertPreferences,
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

interface PreferencesBody {
  theme?: unknown
  encryptionKey?: unknown
}

/** GET /auth/preferences —— 返回 { theme, encryptionKey }（key 解密后明文）。 */
export async function handlePreferencesGet(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveSessionUserId(request, env)
  if (githubId === null) return json({ authed: false })

  const row = await getPreferences(env, githubId)
  const encKey = env.TOKEN_ENC_KEY ?? env.GITHUB_CLIENT_SECRET

  let encryptionKey: string | null = null
  if (row?.encryption_key_enc) {
    encryptionKey = await decryptToken(encKey, row.encryption_key_enc)
  }

  return json({
    authed: true,
    preferences: {
      theme: row?.theme ?? null,
      encryptionKey,
    },
  })
}

/** PUT /auth/preferences —— 更新 theme / encryptionKey（可部分更新）。 */
export async function handlePreferencesPut(
  request: Request,
  env: Env
): Promise<Response> {
  const githubId = await resolveSessionUserId(request, env)
  if (githubId === null) return json({ authed: false })

  let body: PreferencesBody
  try {
    body = (await request.json()) as PreferencesBody
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400)
  }

  const encKey = env.TOKEN_ENC_KEY ?? env.GITHUB_CLIENT_SECRET
  const update: {
    githubId: number
    theme?: string | null
    encryptionKeyEnc?: string | null
  } = { githubId }

  if (body.theme !== undefined) {
    if (typeof body.theme !== "string" || body.theme.length > 64 * 1024) {
      return json({ ok: false, error: "bad-theme" }, 400)
    }
    update.theme = body.theme
  }
  if (body.encryptionKey !== undefined) {
    if (typeof body.encryptionKey !== "string" || body.encryptionKey.length > 8 * 1024) {
      return json({ ok: false, error: "bad-encryption-key" }, 400)
    }
    // 空串表示清除已设置的加密 key
    update.encryptionKeyEnc =
      body.encryptionKey === "" ? null : await encryptToken(encKey, body.encryptionKey)
  }

  await upsertPreferences(env, update)
  return json({ ok: true })
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
