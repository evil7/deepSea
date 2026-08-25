// deepc-link 3081 鉴权代理实机测试（Node 脚本，无需 dsh host）
//
// 场景：mock 3080 上游（返回 "HELLO FROM DSH"）+ 真实 3081 鉴权代理。
// 验证：
//   1. 无 cookie → 401 + 鉴权页（6 位 2FA 输入）
//   2. POST /__deepc_auth（错误动态码）→ 401
//   3. POST /__deepc_auth（正确 TOTP 动态码）→ Set-Cookie + 302
//   4. 带 cookie 访问 → 反代 200 返回上游内容
//   5. 错误码连败 5 次 → 429 锁定
//   6. WS 未鉴权 → 拒绝
//
// 运行：先 node test/build-tests.mjs，再 node test/auth-proxy.test.mjs

import { createServer } from 'node:http'
import { createAuthProxy } from './.auth-proxy.bundle.mjs'
import { generateTotpSecret, totpCode } from './.totp.bundle.mjs'

// ── mock 3080 上游（dsh 官方；用 3090 避免与真实 dsh 3080 冲突）────────
const upstream = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('HELLO FROM DSH 3080')
})
await new Promise((r) => upstream.listen(3090, '127.0.0.1', r))
console.log('✓ mock 上游已启动 :3090')

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

async function req(path, { method = 'GET', cookie, body, form } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  let payload
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    payload = form
  } else if (body) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' })
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
let r = await req('/')
check('无 cookie → 401', r.status === 401)
check('响应为鉴权页', r.text.includes('deepc-link 安全验证'))
check('鉴权页含 6 位 2FA 输入', r.text.includes('6 位动态码') || r.text.includes('2FA'))

// ── 2. 错误动态码 → 401 ───────────────────────────────────────────────
r = await req('/__deepc_auth', { method: 'POST', form: 'code=000000' })
check('错误动态码 → 401', r.status === 401 && r.text.includes('bad-code'))

// ── 3. 正确 TOTP 动态码 → Set-Cookie + 302 ───────────────────────────
const goodCode = totpCode(SECRET)
r = await req('/__deepc_auth', { method: 'POST', form: `code=${goodCode}` })
check('正确动态码 → 302', r.status === 302)
check(
  '种 dc_site cookie（Partitioned）',
  (r.setCookie || '').includes('dc_site=') && (r.setCookie || '').includes('Partitioned'),
)

// ── 4. 带 cookie → 反代上游 200 ───────────────────────────────────────
const cookie = r.setCookie.split(';')[0]
r = await req('/', { cookie })
check('带 cookie 访问 → 200', r.status === 200)
check('返回上游内容', r.text.includes('HELLO FROM DSH 3080'))

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
    ws.onopen = () => rej(new Error('unexpected-open'))
    ws.onerror = () => res()
    setTimeout(() => rej(new Error('timeout')), 2000)
  })
  check('WS 未鉴权 → 拒绝', true)
} catch {
  check('WS 未鉴权 → 拒绝', false)
}

// ── 清理 ──────────────────────────────────────────────────────────────
await proxy.stop()
upstream.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
