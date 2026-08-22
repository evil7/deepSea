/**
 * deepc-link node 端 WebRTC polyfill 注入。
 *
 * node-datachannel 的 `/polyfill` 入口提供与浏览器 WebRTC API 结构对齐的
 * `RTCPeerConnection` / `RTCDataChannel` 等（headless 端点，libdatachannel 绑定，
 * 无需本地浏览器）。注入 globalThis 后，session.ts 里对浏览器 DOM 全局类型
 * （`RTCPeerConnection` 等）的裸引用即可在 node 端运行时解析——session.ts
 * 因此可两端复用、零改动。
 *
 * 注意：本模块仅被 node 端入口（`index.ts`）引用。browser 端
 * （`client/index.ts`）不得 import——浏览器有原生 WebRTC，且本模块会引入
 * node 原生依赖。
 */

import {
  RTCPeerConnection,
  RTCDataChannel,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'node-datachannel/polyfill'

/**
 * 注入 WebRTC 全局（幂等：已有全局时保留不覆盖）。
 * 必须在任何 session.ts 会话 API 被调用之前执行。
 */
export function installRtcPolyfill(): void {
  const g = globalThis as unknown as Record<string, unknown>
  g.RTCPeerConnection ??= RTCPeerConnection
  g.RTCDataChannel ??= RTCDataChannel
  g.RTCSessionDescription ??= RTCSessionDescription
  g.RTCIceCandidate ??= RTCIceCandidate
}
