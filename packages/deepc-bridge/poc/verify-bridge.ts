// ---------------------------------------------------------------------------
// S2 POC —— node 端数据面桥端到端验证
// host 端 attach HttpLocalApi 桥 + client 端（模拟 chatUI）发 unary 帧收结果、
// 订阅下行流收 downstream 帧。运行前需 dsh host（3080）+ worker 信令（8787）。
//
// 构建 + 运行：
//   npx esbuild poc/verify-bridge.ts --bundle --format=esm --platform=node \
//     --external:node-datachannel --external:node-datachannel/polyfill \
//     --outfile=poc/verify-bridge.mjs && node poc/verify-bridge.mjs
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

import { createHostOffer, finalizeHost, startClientSessionDetailed } from '../src/session'
import { installApiBridge } from '../src/api-bridge'
import { installHostHandshake } from '../src/host-handshake'
import { HttpLocalApi } from '../src/local-api'
import type { BridgeFrame } from '../src/protocol'

const SIGNAL_BASE = 'http://127.0.0.1:8787'

async function main() {
  const offer = await createHostOffer({ signalBase: SIGNAL_BASE })
  if (!offer) throw new Error('createHostOffer failed')
  console.log('pairCode:', offer.pairCode)

  // 并发：host 等 answer + client 连接
  const [hostResult, clientOutcome] = await Promise.all([
    finalizeHost(offer, { signalBase: SIGNAL_BASE }),
    startClientSessionDetailed(offer.pairCode, { signalBase: SIGNAL_BASE }),
  ])
  if (!hostResult) throw new Error('finalizeHost failed')
  if (!clientOutcome.session) throw new Error(`startClientSession failed: ${clientOutcome.error}`)
  const host = hostResult
  const client = clientOutcome.session
  console.log('host DC:', host.dc.readyState, '| client DC:', client.dc.readyState)

  // host 端：attach 数据面桥 + 握手（HttpLocalApi → 127.0.0.1:3080）
  const api = new HttpLocalApi()
  const bridge = installApiBridge(host.dc, api)
  const handshake = installHostHandshake(host.dc, api)

  // client 端：收 host 回传的帧（先注册监听，再等待握手/数据帧）
  const waiters: Array<(frame: BridgeFrame) => boolean> = []
  client.dc.addEventListener('message', (ev: MessageEvent) => {
    const frame = JSON.parse(String(ev.data)) as BridgeFrame
    const idx = waiters.findIndex((w) => w(frame))
    if (idx >= 0) waiters.splice(idx, 1)
  })
  function waitFor(pred: (f: BridgeFrame) => boolean, ms = 5000): Promise<BridgeFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timeout')), ms)
      waiters.push((f) => {
        if (pred(f)) {
          clearTimeout(timer)
          resolve(f)
          return true
        }
        return false
      })
    })
  }
  function send(frame: BridgeFrame) {
    if (client.dc.readyState === 'open') client.dc.send(JSON.stringify(frame))
  }

  // 0) hello：node 端自动推送基础信息（host/theme/model）
  const helloP = waitFor((f) => f.kind === 'hello')
  const hello = await helloP
  console.log('hello:', JSON.stringify(hello).slice(0, 200))

  // 1) unary：host.describe
  const unaryP = waitFor((f) => f.kind === 'unary-result' && f.rpcId === 'r-describe')
  send({ kind: 'unary', rpcId: 'r-describe', method: 'host.describe', payload: {} })
  const unaryRes = await unaryP
  console.log('unary-result:', JSON.stringify(unaryRes).slice(0, 160))

  // 2) subscribe：events.mux 下行流
  const downP = waitFor((f) => f.kind === 'downstream', 8000)
  send({ kind: 'subscribe', subId: 's-mux', stream: 'mux' })
  const down = await downP
  console.log('downstream:', JSON.stringify(down).slice(0, 160))

  // 3) unsubscribe
  send({ kind: 'unsubscribe', subId: 's-mux' })

  console.log('BRIDGE POC PASS ✅')
  bridge.dispose()
  handshake.dispose()
  host.close()
  client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('BRIDGE POC FAIL ❌', e)
  process.exit(1)
})

setTimeout(() => {
  console.error('TIMEOUT ❌')
  process.exit(1)
}, 20000)
