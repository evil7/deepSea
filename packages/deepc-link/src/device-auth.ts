/**
 * deepc-link 设备授权 —— 环境基址常量 + 用户档案换取（node 端专属）。
 *
 * 连接层在插件后端（node 端）：device_token 由后端（node-host.ts 的 NodeTokenStore）
 * 内存自持并轮询换取，权威流程见 node-host.ts。本文件只提供：
 *   · DEFAULT_SITE_BASE / DEFAULT_SIGNAL_BASE —— 构建期注入环境基址（node 端共用）
 *   · fetchDeviceProfile(token) —— 用 device_token 换用户档案（头像/昵称展示）
 */

/**
 * 构建时由 esbuild `--define` 注入的环境基址（见 scripts/build.mjs）：
 *   **单一产物，默认生产基址 `https://deepc.cn`**。本地 dev 联调无需单独编译——
 *   运行时在 node-host.ts 打开「开发模式」开关后，基址解析切到
 *   `http://127.0.0.1:5174`（vite 代理 /auth/* /ws/* /api/* 到 worker 8787）。
 *   故两个常量值恒相等（仅语义命名区分「主站」与「信令」）。
 */
declare const __DEEPC_SITE_BASE__: string
declare const __DEEPC_SIGNAL_BASE__: string

/** 主站基址（构建注入；本地 dev 用 127.0.0.1:5174，可由 opts 覆盖）。 */
export const DEFAULT_SITE_BASE = __DEEPC_SITE_BASE__

/** 信令/Worker 基址（构建注入；与主站同源，本地 dev 用 127.0.0.1:5174）。 */
export const DEFAULT_SIGNAL_BASE = __DEEPC_SIGNAL_BASE__

export interface DeviceProfile {
  login: string
  avatar_url: string
  name: string | null
}

/** 用 device_token 换取用户档案（头像/昵称展示；不含 GitHub token）。 */
export async function fetchDeviceProfile(
  token: string,
  opts: { signalBase?: string } = {}
): Promise<{ profile: DeviceProfile } | null> {
  const signalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE
  try {
    const res = await fetch(`${signalBase}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      authed?: boolean
      user?: DeviceProfile
    }
    if (body.authed !== true || !body.user) return null
    return { profile: body.user }
  } catch {
    return null
  }
}
