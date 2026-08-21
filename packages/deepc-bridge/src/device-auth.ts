/**
 * deepc-bridge 插件端设备授权 —— Device Grant 流（主动登录）。
 *
 * 插件端跑在 http://127.0.0.1:3080（本地 dsh 前端），拿不到 deepc 主站的
 * ds_session cookie（domain 绑定 deepc.cn）。因此经 Device Grant 流换取独立
 * 设备凭证 device_token：
 *
 *   ① 点「登录」→ 本端生成 state(uuid) → 打开主站 /device-login?state=xxx
 *   ② 主站确认页（未登录先 OAuth，已登录展示「确认授权」）→ 用户确认
 *   ③ 本端轮询 POST /auth/device-grant/poll { state } → 一次性换取 device_token
 *   ④ 持久化 localStorage → 后续 node 端点带 Authorization: Bearer device_token
 *
 * token 只存本地（localStorage），不落盘文件、不上传明文。
 */

import { generateConnectId } from './crypto'

/**
 * 构建时由 esbuild `--define` 注入的环境基址（见 scripts/build.mjs）：
 *   · __DEEPC_SITE_BASE__：主站基址（生产 https://deepc.cn；本地 dev 127.0.0.1:5174）
 *   · __DEEPC_SIGNAL_BASE__：Worker/信令基址（生产 https://deepc.cn；本地 127.0.0.1:8787）
 * 两者必须指向同一环境，否则「打开主站确认页」与「轮询换 token」会错位，导致授权卡死。
 */
declare const __DEEPC_SITE_BASE__: string
declare const __DEEPC_SIGNAL_BASE__: string

/** device_token 本地持久化键。 */
const DEVICE_TOKEN_KEY = 'deepc.deviceToken'

/** 主站基址（构建注入；本地 dev 用 127.0.0.1:5174 可由 opts 覆盖）。 */
export const DEFAULT_SITE_BASE = __DEEPC_SITE_BASE__

/** Worker/信令基址（构建注入；本地 dev 用 127.0.0.1:8787）。 */
export const DEFAULT_SIGNAL_BASE = __DEEPC_SIGNAL_BASE__

/** 授权码收件箱键本地暂存（跨页面轮询恢复用）。 */
const DEVICE_STATE_KEY = 'deepc.deviceState'

export interface DeviceAuthOptions {
  /** 信令/API 服务基址（worker，/auth/*）。 */
  signalBase?: string
  /** 主站基址（打开授权确认页 / 登录跳转用）。 */
  siteBase?: string
  /** 轮询超时（毫秒，默认 5 分钟对齐 KV TTL）。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒，默认 2s）。 */
  intervalMs?: number
}

export interface DeviceProfile {
  login: string
  avatar_url: string
  name: string | null
}

/** 读取本地已持久化的 device_token（可能已过期，调用方自行校验）。 */
export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY)
  } catch {
    return null
  }
}

/** 清除本地 device_token + 授权码收件箱键。 */
export function clearStoredToken(): void {
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY)
    localStorage.removeItem(DEVICE_STATE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * 发起设备授权流：生成 state → 打开主站确认页 → 轮询换取 device_token。
 * 返回 token（成功）或 null（超时/取消/失败）。
 */
export async function startDeviceAuth(
  opts: DeviceAuthOptions = {}
): Promise<string | null> {
  const signalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE
  const siteBase = opts.siteBase ?? DEFAULT_SITE_BASE
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  const intervalMs = opts.intervalMs ?? 2_000

  // ① 生成 state（uuid，作换取 token 的收件箱钥匙）。
  const state = generateConnectId()
  try {
    localStorage.setItem(DEVICE_STATE_KEY, state)
  } catch {
    /* ignore */
  }

  // ② 打开主站授权确认页（新窗口；路径非 /auth/* 以避开 vite proxy）。
  window.open(`${siteBase}/device-login?state=${encodeURIComponent(state)}`, '_blank')

  // ③ 轮询换取 token（一次性消费）。
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const token = await pollDeviceGrant(signalBase, state)
    if (token) {
      try {
        localStorage.setItem(DEVICE_TOKEN_KEY, token)
        localStorage.removeItem(DEVICE_STATE_KEY)
      } catch {
        /* ignore */
      }
      return token
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  try {
    localStorage.removeItem(DEVICE_STATE_KEY)
  } catch {
    /* ignore */
  }
  return null
}

/** 单次轮询：换取 device_token（未授权返回 null 继续等）。 */
async function pollDeviceGrant(
  signalBase: string,
  state: string
): Promise<string | null> {
  try {
    const res = await fetch(`${signalBase}/auth/device-grant/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; token?: string }
    return body.ok === true && typeof body.token === 'string' ? body.token : null
  } catch {
    return null
  }
}

/** 用 device_token 换取用户档案（头像/昵称展示；不含 GitHub token）。 */
export async function fetchDeviceProfile(
  token: string,
  opts: DeviceAuthOptions = {}
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
