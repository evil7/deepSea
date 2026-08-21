/**
 * deepc-bridge node 端握手（hello）—— 连接建立后主动推送基础信息对齐 chatUI。
 *
 * 职责：绑定 DataChannel，在 DC open 时调本地 API 采集基础信息，一次性下发
 * hello 帧（protocolVersion + host 元信息 + 主题 + 模型），并处理 chatUI 的
 * hello-ack。使远端 chatUI 无需逐个 unary 即可渲染 host 信息 / 主题 / 模型。
 *
 * 采集项（经 LocalApi 抽象，未来可换 toFetchHandler(ctx.apiProxy)）：
 *   · host.describe   → HostInfo（version/cwd/provider/model/...）
 *   · settings.describe → 主题命名空间 value（passthrough）
 *   · session.models  → 当前模型选择（可选，需 sessionId）
 */

import type { HostInfo, HelloFrame, ModelSelection } from './protocol'
import { PROTOCOL_VERSION } from './protocol'
import type { LocalApi } from './local-api'

/** 握手句柄。 */
export interface HostHandshake {
  /** 重新采集并推送 hello（主题/模型变化时调用）。 */
  refresh: () => Promise<void>
  /** 解除监听。 */
  dispose: () => void
}

/** 从 settings.describe 里提取 theme 命名空间的 value（passthrough）。 */
function extractTheme(settingsValue: unknown): unknown {
  if (settingsValue && typeof settingsValue === 'object') {
    const namespaces = (settingsValue as { namespaces?: unknown[] }).namespaces
    if (Array.isArray(namespaces)) {
      for (const ns of namespaces) {
        const row = ns as { ns?: string; value?: unknown }
        if (row.ns === 'theme') return row.value
      }
    }
  }
  return undefined
}

/**
 * 安装握手：DC open 即采集并推送 hello；处理 hello-ack（当前仅记录）。
 * 返回句柄，可 refresh 重新推送（主题/模型变化时）。
 */
export function installHostHandshake(dc: RTCDataChannel, api: LocalApi): HostHandshake {
  let sent = false

  async function collectAndSend(): Promise<void> {
    let host: HostInfo | undefined
    let theme: unknown
    let model: ModelSelection | undefined

    const hostRes = await api.callUnary('host.describe', {})
    if (hostRes.ok && hostRes.value) host = hostRes.value as HostInfo

    const settingsRes = await api.callUnary('settings.describe', {})
    if (settingsRes.ok && settingsRes.value) {
      theme = extractTheme(settingsRes.value)
    }

    // 模型选择需 sessionId，host 握手阶段无特定会话 → 从 host.describe 的
    // provider/model 兜底（可能为空）。session.models 留待选中会话后再取。
    if (host) {
      model = { provider: host.provider ?? '', model: host.model ?? '' }
    }

    const frame: HelloFrame = {
      kind: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      host: host ?? {
        version: '',
        cwd: '',
        attachedSessions: 0,
        home: '',
        canOpenPath: false,
      },
      theme,
      model,
    }
    if (dc.readyState === 'open') dc.send(JSON.stringify(frame))
    sent = true
  }

  function onOpen(): void {
    void collectAndSend()
  }

  function onMessage(event: MessageEvent): void {
    try {
      const frame = JSON.parse(String(event.data)) as { kind?: string }
      if (frame.kind === 'hello-ack') {
        // chatUI 已确认握手，暂无额外动作（可扩展协商能力位）。
      }
    } catch {
      // 忽略非法帧
    }
  }

  dc.addEventListener('open', onOpen)
  dc.addEventListener('message', onMessage)
  // DC 已 open 时（安装晚于 open）立即推送。
  if (dc.readyState === 'open' && !sent) void collectAndSend()

  function dispose(): void {
    dc.removeEventListener('open', onOpen)
    dc.removeEventListener('message', onMessage)
  }
  dc.addEventListener('close', dispose, { once: true })

  return {
    refresh: collectAndSend,
    dispose,
  }
}
