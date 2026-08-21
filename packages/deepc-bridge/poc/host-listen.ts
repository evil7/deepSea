// ---------------------------------------------------------------------------
// host-listen —— 临时 node 端 host 会话（供 chatUI 端到端联调用）。
// 生成配对码 + offer 入信令 → 等浏览器 chatUI 连入 → 安装 api-bridge + 握手。
//
// 构建 + 运行：
//   esbuild poc/host-listen.ts --bundle --format=esm --platform=node \
//     --external:node-datachannel --external:node-datachannel/polyfill \
//     --outfile=poc/host-listen.mjs && node poc/host-listen.mjs
// ---------------------------------------------------------------------------

import {
  RTCPeerConnection,
  RTCDataChannel,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'node-datachannel/polyfill'

const g = globalThis as unknown as Record<string, unknown>
g.RTCPeerConnection ??= RTCPeerConnection
g.RTCDataChannel ??= RTCDataChannel
g.RTCSessionDescription ??= RTCSessionDescription
g.RTCIceCandidate ??= RTCIceCandidate

import { createHostOffer, finalizeHost } from '../src/session'
import { installApiBridge } from '../src/api-bridge'
import { installHostHandshake } from '../src/host-handshake'
import { HttpLocalApi } from '../src/local-api'

const SIGNAL_BASE = 'http://127.0.0.1:8787'

async function main() {
  const offer = await createHostOffer({ signalBase: SIGNAL_BASE })
  if (!offer) throw new Error('createHostOffer failed')
  console.log('')
  console.log('================================================')
  console.log('  配对码（输入到 chatUI）：', offer.pairCode)
  console.log('================================================')
  console.log('')

  const host = await finalizeHost(offer, { signalBase: SIGNAL_BASE, signalTimeoutMs: 120_000 })
  if (!host) throw new Error('finalizeHost failed（等 chatUI 连入超时）')
  console.log('chatUI 已连入，DC open')

  const api = new HttpLocalApi()
  const bridge = installApiBridge(host.dc, api)
  const handshake = installHostHandshake(host.dc, api)
  console.log('已安装 api-bridge + handshake，等待交互…')

  // 保持运行直到 Ctrl+C。
  process.on('SIGINT', () => {
    bridge.dispose()
    handshake.dispose()
    host.close()
    process.exit(0)
  })
}

main().catch((e) => {
  console.error('FAIL ❌', e)
  process.exit(1)
})
