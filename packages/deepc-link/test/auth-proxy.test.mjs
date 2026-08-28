// deepc-link 3081 鉴权代理实机测试（Node 脚本，无需 dsh host）
//
// 场景一（legacyDsh，无 launch-token）：mock 3080 上游（返回 "HELLO FROM DSH"）
//   + 真实 3081 鉴权代理。验证：门通过 → 仅种 dc_site（自有会话回退）。
// 场景二（新 dsh，带 getLaunchToken）：mock 官方 token 交换端点 + 3082 代理。
//   验证：门通过 → 种 dc_site + 服务端交换官方 cookie 透传；官方 401 + 有效
//   dc_site → 302 /__deepc_reauth 重新过门。
//
// 运行：先 node test/build-tests.mjs，再 node test/auth-proxy.test.mjs

import { createServer, request as httpRequest } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { createAuthProxy } from './.auth-proxy.bundle.mjs'
import { generateTotpSecret, totpCode } from './.totp.bundle.mjs'

/** 复刻插件 verifyTicket：HMAC-SHA256(key=sha512(secret) hex 字符串, msg)。 */
function signTicket(secret, nodeId, ts, nonce) {
  const key = createHash('sha512').update(secret).digest('hex')
  return createHmac('sha256', key).update(`deepc-ticket:${nodeId}:${ts}:${nonce}`).digest('hex')
}

// ── mock 3080 上游（legacy：始终 200；用 3090 避免与真实 dsh 3080 冲突）────────
const upstream = createServer((incoming, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  // 回显远端来源标记头（测试 remote 注入：loopback 无、非 loopback 有）。
  const remote = incoming.headers['x-deepc-remote'] ?? ''
  res.end(`HELLO FROM DSH 3080 remote=${remote}`)
})
await new Promise((ok) => upstream.listen(3090, '127.0.0.1', ok))
console.log('✓ mock 上游已启动 :3090（legacy）')

// ── mock 官方 3080（新架构：token 交换 + cookie 判定；3091）────────────────────
const OFFICIAL_COOKIE =
  'dsh-auth-test=v1.abc.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
const officialUpstream = createServer((incoming, res) => {
  const u = new URL(incoming.url, 'http://x')
  const cookies = (incoming.headers.cookie ?? '').split(';').map((s) => s.trim())
  // 官方 authorizeIndex：GET /?token=<launchToken> → 303 + 签名会话 cookie
  if (incoming.method === 'GET' && u.pathname === '/' && u.searchParams.has('token')) {
    res.writeHead(303, {
      location: '/',
      'cache-control': 'no-store',
      'set-cookie': [OFFICIAL_COOKIE],
    })
    res.end()
    return
  }
  // 带官方 cookie → 已认证 200；否则 401（模拟官方 index 认证拒绝）
  const hasAuth = cookies.some((c) => c.startsWith('dsh-auth-test='))
  if (hasAuth) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('HELLO FROM OFFICIAL DSH 3080')
    return
  }
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('dsh web authentication required')
})
await new Promise((ok) => officialUpstream.listen(3091, '127.0.0.1', ok))
console.log('✓ mock 官方上游已启动 :3091（token 交换 + cookie 判定）')

// ── 3081 鉴权代理（真实代码；反代到 mock 3090）──────────────────────
const proxy = createAuthProxy({
  port: 3081,
  host: '127.0.0.1',
  upstream: 'http://127.0.0.1:3090',
  log: () => {},
})
await proxy.start()
const SECRET = generateTotpSecret()
proxy.setSecret(SECRET)
console.log('✓ 3081 鉴权代理已启动，TOTP secret 已注入')

const base = 'http://127.0.0.1:3081'

async function req(path, { method = 'GET', cookie, body, form, host } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (host) headers.host = host
  let payload
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    payload = form
  } else if (body) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  // GET/HEAD 不允许 body（unicorn/no-invalid-fetch-options）：仅非 GET 时携带
  const init = { method, headers, redirect: 'manual' }
  if (payload !== undefined && method !== 'GET') init.body = payload
  const res = await fetch(base + path, init)
  const setCookie = res.headers.get('set-cookie')
  const text = await res.text()
  return { status: res.status, text, setCookie, headers: res.headers }
}

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

// ── 1. 无 cookie → 401 + 鉴权页 ──────────────────────────────────────
let resp = await req('/')
check('无 cookie → 401', resp.status === 401)
check('响应为鉴权页', resp.text.includes('deepc-link 安全验证'))
check('鉴权页含 6 位 2FA 输入', resp.text.includes('6 位动态码') || resp.text.includes('2FA'))

// ── 1b. 公开静态资源（manifest.webmanifest）→ 免鉴权 200 ─────────────
resp = await req('/manifest.webmanifest')
check('manifest.webmanifest 免鉴权 → 200', resp.status === 200 && resp.text.includes('HELLO FROM DSH 3080'))

// ── 1c. 远端来源标记：loopback Host 无 remote；非 loopback Host 注入 remote=1 ──
// undici fetch 会忽略自定义 Host 头，故用 node:http request 显式设置 Host 模拟隧道域名。
function rawGet(host) {
  return new Promise((resolve) => {
    const r = httpRequest(
      { host: '127.0.0.1', port: 3081, path: '/manifest.webmanifest', method: 'GET', headers: { host } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(body))
      },
    )
    r.on('error', () => resolve(''))
    r.end()
  })
}
resp = await req('/manifest.webmanifest', { host: '127.0.0.1:3081' })
check('loopback Host 无 remote 标记', resp.text.includes('remote=') && !resp.text.includes('remote=1'))
const remoteBody = await rawGet('ala-motherboard-cdna-fence.trycloudflare.com')
check('非 loopback Host 注入 remote=1', remoteBody.includes('remote=1'))

// ── 2. 错误动态码 → 401 ───────────────────────────────────────────────
resp = await req('/__deepc_auth', { method: 'POST', form: 'code=000000' })
check('错误动态码 → 401', resp.status === 401 && resp.text.includes('bad-code'))

// ── 3. 正确 TOTP 动态码 → Set-Cookie + 302 ───────────────────────────
const goodCode = totpCode(SECRET)
resp = await req('/__deepc_auth', { method: 'POST', form: `code=${goodCode}` })
check('正确动态码 → 302', resp.status === 302)
check(
  '种 dc_site cookie（SameSite=Strict，无 Partitioned/Secure）',
  (resp.setCookie || '').includes('dc_site=') &&
    (resp.setCookie || '').includes('SameSite=Strict') &&
    !(resp.setCookie || '').includes('Partitioned') &&
    !(resp.setCookie || '').includes('Secure'),
)

// ── 4. 带 cookie → 反代上游 200 ───────────────────────────────────────
const cookie = resp.setCookie.split(';')[0]
resp = await req('/', { cookie })
check('带 cookie 访问 → 200', resp.status === 200)
check('返回上游内容', resp.text.includes('HELLO FROM DSH 3080'))

// ── 4b. 主站 ticket 免密（跨站 form POST 场景）→ dc_site None+Secure ──
// 关键回归：ticket 来自 deepc.cn 跨站 POST，SameSite=Strict 跨站响应拒存 →
// 免密失效（302 后无 dc_site → 401 TOTP 页）。必须 None+Secure 才能种入。
proxy.setBypass('test-node-1')
const tTs = Date.now()
const tNonce = 'ticket-nonce-1'
const tSig = signTicket(SECRET, 'test-node-1', tTs, tNonce)
resp = await req('/__deepc_ticket', {
  method: 'POST',
  form: `nodeId=test-node-1&ts=${tTs}&nonce=${tNonce}&sig=${tSig}`,
})
check('ticket 免密 → 302', resp.status === 302)
check(
  'ticket 免密 dc_site = SameSite=None; Secure（跨站可种入）',
  (resp.setCookie || '').includes('dc_site=') &&
    (resp.setCookie || '').includes('SameSite=None') &&
    (resp.setCookie || '').includes('Secure'),
)
const ticketCookie = resp.setCookie.split(';')[0]
resp = await req('/', { cookie: ticketCookie })
check('ticket 免密后带 dc_site 访问 → 200', resp.status === 200)

// 错误 ticket → 401 bad-ticket
resp = await req('/__deepc_ticket', {
  method: 'POST',
  form: `nodeId=test-node-1&ts=${tTs}&nonce=${tNonce}&sig=deadbeef`,
})
check('错误 ticket → 401 bad-ticket', resp.status === 401 && resp.text.includes('bad-ticket'))

// ── 5. 防暴力：连败 5 次 → 429 锁定（1 小时）─────────────────────────
// 前面已成功一次（计数重置为 0），这里连发 5 次错误码触发锁定。
let locked = false
for (let i = 0; i < 6; i++) {
  const rr = await req('/__deepc_auth', { method: 'POST', form: 'code=000000' })
  if (rr.status === 429) {
    locked = true
    break
  }
}
check('连败 5 次后锁定 → 429', locked)

// 锁定期间正确码也应被拒
const rLocked = await req('/__deepc_auth', { method: 'POST', form: `code=${totpCode(SECRET)}` })
check('锁定期间正确码也被拒', rLocked.status === 429)

// ── 6. WS 未鉴权 → 拒绝 ───────────────────────────────────────────────
try {
  const ws = new WebSocket('ws://127.0.0.1:3081/socket')
  await new Promise((res, rej) => {
    ws.addEventListener('open', () => rej(new Error('unexpected-open')))
    ws.addEventListener('error', () => res())
    setTimeout(() => rej(new Error('timeout')), 2000)
  })
  check('WS 未鉴权 → 拒绝', true)
} catch {
  check('WS 未鉴权 → 拒绝', false)
}

// ── 清理 ──────────────────────────────────────────────────────────────
await proxy.stop()
upstream.close()

// ════════════════════════════════════════════════════════════════════════
// 场景二：新 dsh（getLaunchToken）→ 门通过后服务端交换官方 cookie 透传
// ════════════════════════════════════════════════════════════════════════
const proxy2 = createAuthProxy({
  port: 3082,
  host: '127.0.0.1',
  upstream: 'http://127.0.0.1:3091',
  getLaunchToken: () => 'test-launch-token',
  log: () => {},
})
await proxy2.start()
const SECRET2 = generateTotpSecret()
proxy2.setSecret(SECRET2)
console.log('\n✓ 3082 鉴权代理已启动（新 dsh，getLaunchToken）')

const base2 = 'http://127.0.0.1:3082'
async function req2(path, { method = 'GET', cookie, form } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  let payload
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    payload = form
  }
  const init = { method, headers, redirect: 'manual' }
  if (payload !== undefined && method !== 'GET') init.body = payload
  const res = await fetch(base2 + path, init)
  const setCookie = res.headers.get('set-cookie')
  const text = await res.text()
  return { status: res.status, text, setCookie, location: res.headers.get('location') }
}

// ── 7. 正确 TOTP → 302 + dc_site + 官方 cookie 透传 ───────────────────
let r2 = await req2('/__deepc_auth', { method: 'POST', form: `code=${totpCode(SECRET2)}` })
check('新 dsh 正确动态码 → 302', r2.status === 302)
check(
  '同时种 dc_site + 透传官方 cookie',
  (r2.setCookie || '').includes('dc_site=') && (r2.setCookie || '').includes('dsh-auth-test='),
)
check(
  '官方 cookie 原样透传（Strict/HttpOnly，无改写）',
  (r2.setCookie || '').includes('SameSite=Strict') && (r2.setCookie || '').includes('HttpOnly'),
)

// ── 8. 带 dc_site + 官方 cookie → 反代 200 ────────────────────────────
const sc2 = r2.setCookie.split(',').map((c) => c.trim().split(';')[0]).join('; ')
r2 = await req2('/', { cookie: sc2 })
check('带双 cookie 访问 → 200', r2.status === 200)
check('返回官方上游内容', r2.text.includes('HELLO FROM OFFICIAL DSH 3080'))

// ── 9. 官方会话失效（仅剩 dc_site，无官方 cookie）→ 302 重新过门 ─────
// 手动构造「已过门但官方 cookie 丢失」：mock 官方对该请求返回 401 →
// 3081 proxyRes 捕获（带有效 dc_site）→ 同步 302 /__deepc_reauth。
// 注：http-proxy 改 302 后 body 仍会 pipe 上游 401 文本，浏览器对 302 忽略 body。
const dcOnly = sc2.split(';').filter((c) => c.trim().startsWith('dc_site=')).join('; ')
r2 = await req2('/', { cookie: dcOnly })
check('官方 401 + 有效 dc_site → 302 /__deepc_reauth', r2.status === 302 && r2.location === '/__deepc_reauth')

// ── 10. GET /__deepc_reauth → 401 鉴权页 + 过期 dc_site ───────────────
r2 = await req2('/__deepc_reauth')
check('reauth → 401 鉴权页', r2.status === 401 && r2.text.includes('deepc-link 安全验证'))
check('reauth 过期旧 dc_site', (r2.setCookie || '').includes('Max-Age=0'))

// ── 11. 伪造者：无 dc_site 直接访问 / → 3081 层 401 鉴权页（不反代）──
r2 = await req2('/')
check('无 dc_site 访问 / → 401 鉴权页（门禁拦截）', r2.status === 401 && r2.text.includes('deepc-link 安全验证'))

// ── 清理 ──────────────────────────────────────────────────────────────
await proxy2.stop()
officialUpstream.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
