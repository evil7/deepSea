/**
 * deepc-link monkey-patch 统一介入层。
 *
 * 把所有「无法从插件层干净实现、需要覆盖/纠正 dsh 原有行为」的介入点收敛到本文件，
 * 统一提供：环境判定（isRemote）、patch 注册表、幂等守卫、逐项 try/catch 降级。
 *
 * 每个 patch 首行自带「远端/内存模式」等守卫，本地（loopback）零介入，不影响正常功能。
 * 后续 P1~P4（打开配置文件 / 打开文件 / Agent 预设查看 / 插件配置卡片）在此注册新 patch。
 *
 * 参考（GitHub 调研，见 docs/deepsea-deepc-monkey-patch-plan.md）：
 *   · xgone/dsh-remote —— unpinRemoteSettingsScopes（enqueue 去早退）、/auth/file 远端文件侧边栏、
 *     cordis.patch.yml 禁用 native 换官方 browse。
 *   · JUANWANG-BUAA/dsh-full-remote —— index-tap 提前 pin connection.isLoopback、
 *     trustSettingsPersistence（bind 包裹）。
 */

import { registerBrowseDirectoryPicker, type SlotsCtx } from './directory-picker'
import { installFileViewer, openFilePreview } from './file-viewer'

/** dsh 前端 connection 服务 handle（client-connection 提供；isLoopback 为可覆盖属性）。 */
export interface ConnectionHandle {
  isLoopback: boolean
  /** 页面生命周期内唯一的 IApiClient（boot 时 createApiClient 创建）。 */
  api?: {
    host?: {
      /** wire RPC "host.openPath"（arrow 属性，可安全替换）。 */
      openPath?: (payload: { path?: string }, signal?: unknown) => Promise<unknown>
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * settingsScope 的共享 describe mirror（dsh-client-ui-settings 提供）。
 * 宽松形状：描述面真实接口为 getSnapshot/subscribe/ensure/acceptView，
 * 旧版 persistence/load 已不在此面（保留 [key: string]: unknown 兼容运行时探测）。
 */
export interface SettingsDescribeMirror {
  /** 从 host 拉取 settings.describe（旧版签名，新版为 ensure()；运行时探测）。 */
  load?: () => unknown
  [key: string]: unknown
}

/**
 * settingsScope 绑定的单 namespace scope（bind({namespace}) 返回）。
 * 宽松形状：真实接口见 dsh-client-runtime 的 SettingsScope<T>。
 */
export interface SettingsNamespaceScope {
  getSnapshot: () => {
    status?: string
    value?: Record<string, unknown>
    [key: string]: unknown
  }
  subscribe: (listener: () => void) => () => void
  [key: string]: unknown
}

/** settingsScope 服务（SettingsScopeBinder）。 */
export interface SettingsScopeService {
  describe: () => SettingsDescribeMirror
  /** 绑定一个 settings namespace 的 scope（如 { namespace: 'locale' }）。 */
  bind: (spec: { namespace: string }) => SettingsNamespaceScope
}

/** deepc-link client 端 monkey-patch 所需的 cordis ctx 面。 */
export interface MonkeyPatchCtx extends SlotsCtx {
  connection: ConnectionHandle
  settingsScope: SettingsScopeService
}

/** loopback 判定（与 dsh isLoopbackHostname 对齐；独立实现，不依赖连接服务与加载顺序）。 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = (hostname ?? '').toLowerCase()
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true
  const parts = h.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  )
}

/** 当前页面是否为远端访问（非 loopback → 需要介入）。 */
export function isRemote(): boolean {
  try {
    return !isLoopbackHostname(window.location.hostname)
  } catch {
    return false
  }
}

/** 幂等守卫：apply 可能被重复调用，只介入一次。 */
let installed = false

/**
 * 安装所有 monkey-patch。每个 patch 独立 try/catch 降级——单个 patch 因版本漂移失败时，
 * 只跳过它自己，不拖垮其它 patch、不阻塞 dsh boot。
 */
export function installMonkeyPatches(ctx: MonkeyPatchCtx): void {
  if (installed) return
  installed = true

  const patches: Array<[string, () => void]> = [
    ['settings-mirror', () => patchSettingsMirror(ctx)],
    ['directory-picker', () => patchDirectoryPicker(ctx)],
    ['open-file', () => patchOpenFile(ctx)],
  ]

  for (const [name, fn] of patches) {
    try {
      fn()
    } catch (err) {
      console.warn(
        `[deepc-link] monkey-patch "${name}" 失败（已降级跳过）:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

/**
 * patch：settings 共享 mirror（远端恢复 host 模式）。
 *
 * 背景：dsh 前端凭 location.hostname 判定 connection.isLoopback，远端 → false → settings
 * 走 "memory" 持久化（不发起 settings.describe RPC），导致「模型 / Agent 预设」等设置项
 * 在远端失效。deepc-link 的 3081 已做 TOTP 2FA 鉴权，反代（changeOrigin 让 Host=loopback +
 * 剥离 Origin）又让 settings.* 特权 RPC 经 3081 均 200（实测验证）。故：
 *   1) 覆盖 isLoopback = true（表达「已鉴权即视为本地」）；
 *   2) 把已建成 "memory" 的共享 mirror 切回 "host" 并重新拉取。
 * 本地（isLoopback 本为 true / mirror 本为 "host"）二者均不触发。
 */
function patchSettingsMirror(ctx: MonkeyPatchCtx): void {
  const connection = ctx.connection
  if (connection && typeof connection.isLoopback === 'boolean') {
    connection.isLoopback = true
  }
  // 新版 dsh：describe face 无 persistence/load 字段（改 getSnapshot/subscribe/ensure），
  // 远端 memory 模式不再通过改 mirror 字段恢复；此处保留运行时探测——若旧版字段存在才补救。
  const mirror = ctx.settingsScope?.describe?.() as
    | (SettingsDescribeMirror & { persistence?: string; load?: () => unknown })
    | undefined
  if (mirror && mirror.persistence === 'memory') {
    mirror.persistence = 'host'
    void mirror.load?.()
  }
}

/**
 * patch：目录选择器（浏览器内目录浏览，shadow 原生 OS 选择器）。
 *
 * dsh 的 directory-picker-auto 在 loopback 部署下调用宿主机原生 OS 对话框（远端看不到），
 * 这里以 priority:-1 成为 directoryFlow single-slot 的 winner，替换为浏览器内目录浏览 UI。
 * 本地（3080 直连）与远端（3081 反代）统一走 /deepc/list-dir + /deepc/create-dir 枚举。
 */
function patchDirectoryPicker(ctx: MonkeyPatchCtx): void {
  registerBrowseDirectoryPicker(ctx)
}

/**
 * patch：打开文件/路径 `host.openPath`（B 类「宿主机副作用能力」，远端接管）。
 *
 * dsh 的 ProducedFiles「打开」按钮最终汇入 `connection.api.host.openPath`（wire RPC），
 * 宿主机用系统默认应用打开文件——远端浏览器看不到。这里在远端把该 RPC 替换为浏览器内
 * 只读预览（`/deepc/read-file`），本地（loopback）保持原生打开行为。
 *
 * 关键：workspaces.openPath 拿到响应后做 `if (!response.result.ok) throw ...` 校验，
 * 故替换实现必须 resolve `{ result: { ok: true } }`（对齐 RpcResponse 结构），否则
 * requestOpenFile 会误弹「打开失败」。
 */
function patchOpenFile(ctx: MonkeyPatchCtx): void {
  if (!isRemote()) return
  const host = ctx.connection?.api?.host
  const original = host?.openPath
  if (!host || typeof original !== 'function') return
  installFileViewer()
  host.openPath = (payload, signal) => {
    const path = payload?.path
    if (typeof path === 'string' && path !== '') {
      openFilePreview(path)
      return Promise.resolve({ result: { ok: true } })
    }
    return original(payload, signal)
  }
}
