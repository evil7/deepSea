// ---------------------------------------------------------------------------
// S1 端到端验证 —— node 端 host ↔ client 经 worker 信令互通
// 验证 session.ts 完整逻辑（crypto 配对码 + signaling 信令 + polyfill DC）
// 在 node 端全链路跑通。运行前需 worker 信令服务（8787）在跑。
//
// 构建 + 运行：
//   npx esbuild poc/verify-e2e.ts --bundle --format=esm --platform=node \
//     --external:node-datachannel --external:node-datachannel/polyfill \
//     --outfile=poc/verify-e2e.mjs && node poc/verify-e2e.mjs
// ---------------------------------------------------------------------------

import {
  RTCPeerConnection,
  RTCDataChannel,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'node-datachannel/polyfill'

// 注入全局（须在调用任何 session API 前）。
const g = globalThis as unknown as Record<string, unknown>
g.RTCPeerConnection ??= RTCPeerConnection
g.RTCDataChannel ??= RTCDataChannel
g.RTCSessionDescription ??= RTCSessionDescription
g.RTCIceCandidate ??= RTCIceCandidate

import {
  createHostOffer,
  finalizeHost,
  startClientSessionDetailed,
} from '../src/session'

const SIGNAL_BASE = 'http://127.0.0.1:8787'

async function main() {
  // host 阶段 1：生成配对码 + offer 入信令
  const offer = await createHostOffer({ signalBase: SIGNAL_BASE })
  if (!offer) throw new Error('createHostOffer failed')
  console.log('pairCode:', offer.pairCode)

  // 并发：host 等 answer（finalize）+ client 连接（startClientSessionDetailed）。
  // 两端必须并发——client 等 datachannel 事件需要 host 也完成 ICE 协商。
  const [hostResult, clientOutcome] = await Promise.all([
    finalizeHost(offer, { signalBase: SIGNAL_BASE }),
    startClientSessionDetailed(offer.pairCode, { signalBase: SIGNAL_BASE }),
  ])
  if (!hostResult) throw new Error('finalizeHost failed')
  if (!clientOutcome.session) throw new Error(`startClientSession failed: ${clientOutcome.error}`)
  const host = hostResult
  const client = clientOutcome.session
  console.log('host DC:', host.dc.readyState, '| client DC:', client.dc.readyState)

  console.log('E2E PASS ✅')
  host.close()
  client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('E2E FAIL ❌', e)
  process.exit(1)
})

setTimeout(() => {
  console.error('TIMEOUT ❌')
  process.exit(1)
}, 20000)
