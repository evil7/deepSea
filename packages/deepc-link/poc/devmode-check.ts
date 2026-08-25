/**
 * 开发模式切换验证：createDeepcHost.handleControl /deepc/devmode + status。
 *
 * 前置：pnpm dev:all 运行中（worker 8787 + web 5174）。
 * 验证：
 *   1. status → devMode=false（默认 production 基址）
 *   2. POST /deepc/devmode {enabled:true} → devMode=true，status 反映
 *   3. POST /deepc/devmode {enabled:false} → 切回
 *   4. 5174（vite 代理 → 本地 worker）report 链路通（开发模式目标基址）
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createDeepcHost } from '../src/host'
import { createTunnelManager } from '../src/tunnel'

const log = (m: string) => console.log(`[devmode] ${m}`)
const TOKEN = process.env.E2E_TOKEN ?? 'dev-token-real-test-001'

const host = createDeepcHost({
  signalBase: 'https://deepc.cn',
  siteBase: 'https://deepc.cn',
  log,
})

// 真实 HTTP server：/deepc/* → host.handleControl（模拟 cordis webServer 注册）
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void host.handleControl(req, res)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const addr = server.address()
const ctlBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
log(`control server → ${ctlBase}`)

const ctl = async (path: string, body?: unknown) => {
  const res = await fetch(`${ctlBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

log('1. status.devMode 初值: ' + host.status().devMode + '（期望 false）')
if (host.status().devMode !== false) {
  log('✗ 初始 devMode 应为 false')
  process.exit(1)
}

const on1 = await ctl('/deepc/devmode', { enabled: true })
log(`2. POST /deepc/devmode {enabled:true} → ${on1.status} ${JSON.stringify(on1.body)}`)
log('   status.devMode=' + host.status().devMode + '（期望 true）')
if (!host.status().devMode) {
  log('✗ devmode 切换失败')
  process.exit(1)
}

const off = await ctl('/deepc/devmode', { enabled: false })
log(`3. POST /deepc/devmode {enabled:false} → ${off.status}，status.devMode=${host.status().devMode}（期望 false）`)

// 4. 5174（vite 代理 → 本地 worker）上报链路（开发模式目标基址）
const tm = createTunnelManager({
  signalBase: 'http://127.0.0.1:5174', // 开发模式基址（vite 代理 → worker）
  token: TOKEN,
  nodeId: '11111111-2222-3333-4444-555555555555',
  nodeName: 'devmode-check',
  log: (m) => console.log(`  [tunnel] ${m}`),
})
const rep = await fetch('http://127.0.0.1:5174/auth/tunnel/report', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    nodeId: '11111111-2222-3333-4444-555555555555',
    nodeName: 'devmode-check',
    url: 'https://devmode-check.trycloudflare.com',
  }),
})
const repBody = (await rep.json()) as { ok?: boolean; securityCode?: string }
log(`4. 5174 report → ${rep.status} ok=${repBody.ok} code=${repBody.securityCode?.slice(0, 8)}…`)
if (rep.status !== 200 || !repBody.ok) {
  log('✗ 5174 链路失败')
  process.exit(1)
}
log('✓ 5174 开发模式链路打通')

server.close()
log('完成')
process.exit(0)
