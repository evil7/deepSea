// ---------------------------------------------------------------------------
// 统一登录入口 —— GitHub OAuth 授权跳转（deepSea 自托管）
//
// 流程：
//   deepSea 顶部「登录」→ 站内 /auth/login（Worker 处理：生成一次性
//   state 写入 KV → 302 GitHub 授权页）→ GitHub 授权 → 回调
//   /auth/callback（Worker 校验 state → code 换 token → 签发会话）→ 回跳站点。
//
// 前端**不直接拼 GitHub authorize URL**（那样 state 不在 Worker KV 中，
// callback 会 invalid_state）；也不持有 client_id（避免打进前端 bundle）。
// 全部 OAuth 细节由 Worker 处理（见 docs/deepsea-oauth-worker.md）。
// ---------------------------------------------------------------------------

/**
 * 构造站内登录入口链接（相对路径，经 vite /auth 代理或线上同源 Worker 处理）。
 * @param redirect 授权成功后的站内回跳路径（默认 /，必须是站内相对路径）
 */
export function loginUrl(redirect = "/"): string {
  const params = new URLSearchParams()
  if (redirect !== "/") {
    params.set("redirect", redirect)
  }
  const qs = params.toString()
  return `/auth/login${qs ? `?${qs}` : ""}`
}
