/**
 * P0 插件端本地端到端联调（真实链路，绕过 cordis 壳直接驱动 tunnel.ts）。
 *
 * 链路：
 *   [mock dsh 3080 上游] ← [3081 鉴权代理] ← [cloudflared Quick Tunnel]
 *     ↕ report（POST /auth/tunnel/report）
 *   [本地 Worker 8787]
 *
 * 验证点：
 *   1. tunnel.connect()：启动 3081 → cloudflared → stdout 解析 trycloudflare URL → report 换码
 *   2. 本地 3081 鉴权：无 cookie 401 → POST /__deepc_auth(ticket) → 302 + Set-Cookie → 反代 200
 *   3. 公网 URL（trycloudflare）同链路（可用 curl 手动打）
 *   4. report 后 Worker list 可见最新 URL + 新安全码
 *
 * 运行（esbuild bundle 注入构建变量后执行）：
 *   pnpm exec esbuild poc/e2e-local.ts --bundle --platform=node --format=esm \
 *     --define:__DEEPC_SITE_BASE__=\"https://deepc.cn\" --define:__DEEPC_SIGNAL_BASE__=\"https://deepc.cn\" \
 *     --outfile=poc/e2e-local.mjs
 *   node poc/e2e-local.mjs
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createTunnelManager } from '../src/tunnel'
import { createAuthProxy } from '../src/auth-proxy'

const WORKER_BASE = process.env.E2E_WORKER ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.E2E_TOKEN ?? 'dev-token-real-test-001'
const NODE_ID = process.env.E2E_NODE_ID ?? '11111111-2222-3333-4444-555555555555'
const NODE_NAME = process.env.E2E_NODE_NAME ?? 'e2e-local-win11'

const log = (m: string) => console.log(`[e2e] ${m}`)

// ── 1. mock dsh 3080 上游 ────────────────────────────────────────────────
const mock3080 = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<html><body><h1>MOCK DSH UI :3080</h1><p>path=${req.url ?? '/'}</p></body></html>`,
  )
})
await new Promise<void>((r) => mock3080.listen(3080, '127.0.0.1', r))
log('mock dsh 3080 上游已启动')

// ── 2. tunnel manager connect（核心被测链路）─────────────────────────────
const tm = createTunnelManager({
  signalBase: WORKER_BASE,
  token: TOKEN,
  nodeId: NODE_ID,
  nodeName: NODE_NAME,
  log: (m) => console.log(`  [tunnel] ${m}`),
})

log('connect() 开始：3081 启动 → cloudflared → 解析 URL → report 换码')
const r = await tm.connect()
log(`connect() = ${JSON.stringify(r)}`)
if (!r.ok || !r.url) {
  log('✗ connect 失败，终止')
  process.exit(1)
}
const url = r.url
const code = tm.securityCode()
log(`✓ tunnel URL: ${url}`)
log(`✓ 安全码(仅内存): ${code?.slice(0, 8)}…(${code?.length}hex)`)
log(`✓ status: ${JSON.stringify(tm.status())}`)

// ── 3. Worker 侧确认：list 显示最新 URL ─────────────────────────────────
const listRes = await fetch(`${WORKER_BASE}/auth/tunnel/list`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
})
const listBody = (await listRes.json()) as {
  nodes?: { nodeId: string; url: string | null }[]
}
const mine = listBody.nodes?.find((n) => n.nodeId === NODE_ID)
log(`✓ Worker list 可见: url=${mine?.url}（list=${listRes.status}）`)
if (mine?.url !== url) log('⚠ list URL 与本地不一致（可能热重载竞态，稍后复验）')

// ── 4. 本地 3081 鉴权链路（浏览器视角模拟）───────────────────────────────
//    a. GET / → 应 401 + 鉴权页
const noAuth = await fetch('http://127.0.0.1:3081/')
log(`[a] 无 cookie GET / → ${noAuth.status}（期望 401）`)
if (noAuth.status !== 401) log('⚠ 期望 401 未命中')

//    b. 前端流程：Worker access 签发 ticket → POST 3081 /__deepc_auth
const accRes = await fetch(
  `${WORKER_BASE}/auth/tunnel/access?node=${encodeURIComponent(NODE_ID)}`,
  { headers: { Authorization: `Bearer ${TOKEN}` } },
)
const acc = (await accRes.json()) as { ok?: boolean; url?: string; ticket?: string }
log(`[b] Worker access → ok=${acc.ok} url=${acc.url}`)
if (!acc.ticket) {
  log('✗ 无 ticket，终止')
  process.exit(1)
}

//    构造 form POST（iframe auto-post 同款：application/x-www-form-urlencoded）
const form = new URLSearchParams({ ticket: acc.ticket })
const authRes = await fetch('http://127.0.0.1:3081/__deepc_auth', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form.toString(),
  redirect: 'manual',
})
const setCookie = authRes.headers.get('set-cookie') ?? ''
const location = authRes.headers.get('location') ?? ''
log(`[b] POST /__deepc_auth → ${authRes.status}（期望 302）Location=${location}`)
log(`[b] Set-Cookie: ${setCookie.split(';')[0]}（含 Partitioned=${setCookie.includes('Partitioned')}）`)

//    c. 带 cookie GET / → 应 200 反代 mock 内容
const cookieVal = setCookie.split(';')[0]
const authed = await fetch('http://127.0.0.1:3081/', {
  headers: { Cookie: cookieVal },
})
const body = await authed.text()
log(`[c] 带 dc_site cookie GET / → ${authed.status}（期望 200 反代 3080）`)
log(`[c] 内容包含 MOCK: ${body.includes('MOCK DSH UI')}`)

// ── 5. 输出公网验证指引 ──────────────────────────────────────────────────
log('')
log(`公网链路验证（浏览器 / curl 打真实 trycloudflare URL）：`)
log(`  curl -v ${url}/__deepc_auth -X POST -d 'ticket=${acc.ticket}' -D -`)
log(`  （正常流程：前端 iframe auto-post ticket → 302 Set-Cookie → 302 回 ${url}/）`)
log('')
const hold = Number(process.env.E2E_HOLD_SECONDS ?? 30)
log(`e2e 完成 ✅ 保持进程 ${hold}s（供手动 curl 公网 URL）…`)
await new Promise((r) => setTimeout(r, hold * 1000))

// ── 清理 ────────────────────────────────────────────────────────────────
await tm.disconnect()
mock3080.close()
log('已断开 cloudflared + 3081 + mock 3080，退出')
process.exit(0)
