/**
 * host-ui 共享类型 —— 与 node 端 host.ts 的 DeepcHostStatus 对齐。
 */

export type LinkMode = 'local' | 'tunnel' | 'managed'

/** 隧道映射状态机（off/待下载/下载中/已下载/启动中/已启动/已纳管）。 */
export type TunnelState =
  | 'off'
  | 'download-pending'
  | 'downloading'
  | 'downloaded'
  | 'starting'
  | 'running'
  | 'managed'

/** 后端状态快照（对齐 host.ts 的 DeepcHostStatus）。 */
export interface BackendStatus {
  mode: LinkMode
  loggedIn: boolean
  deviceName: string
  connected: boolean
  url: string | null
  localUrl: string | null
  localOn: boolean
  totpSecret: string | null
  otpauthUri: string | null
  devMode?: boolean
  allowBypass?: boolean
  /** 当前 dsh 是否为不支持 launch-token 的旧版本（提示降级插件/升级 dsh）。 */
  legacyDsh?: boolean
  connectedAt?: number | null
  tunnelState?: TunnelState
  profile?: { login: string; avatar_url: string; name: string | null }
  error?: string
}

export type HostState = 'idle' | 'ready'

export interface HostUi {
  state: HostState
  dispose: () => void
}
