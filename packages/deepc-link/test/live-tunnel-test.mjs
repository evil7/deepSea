// 公网 tunnel URL 完整链路测试（经 trycloudflare → 3081 鉴权 → 反代 3080）
// 用法：node test/live-tunnel-test.mjs <tunnel-url>
import { createHmac } from 'node:crypto'

const URL_ARG = process.argv[2]
const SECRET = '7TQMUQZ6RTLE4IK7AS2C2Z2HIX2X6VHY'

if (!URL_ARG) {
  console.error('用法：node test/live-tunnel-test.mjs <tunnel-url>')
  process.exit(2)
}
const BASE = URL_ARG.replace(/\/$/, '')

// TOTP（RFC 6238）
function base32Decode(s) {
  s = s.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  let bits = 0, value = 0
  const out = []
  for (const ch of s) {
    const idx = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return new Uint8Array(out)
}
function totp(secret, time = Date.now()) {
  const counter = Math.floor(time / 1000 / 30)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter), 0)
  const hmac = createHmac('sha1', Buffer.from(base32Decode(secret))).update(msg).digest()
  const off = hmac[hmac.length - 1] & 0x0f
  const bin = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff)
  return String(bin % 1000000).padStart(6, '0')
}

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + ' ' + extra) }
}

console.log('测试公网 URL:', BASE)

// 1. 无 cookie → 401 + 鉴权页（经 CF 隧道到 3081）
let r = await fetch(BASE + '/', { redirect: 'manual' })
const body1 = await r.text()
check('公网无 cookie → 401', r.status === 401, 'status=' + r.status)
check('公网返回 2FA 鉴权页', body1.includes('deepc-link 安全验证'), 'len=' + body1.length)

// 2. 正确 TOTP 码 → 302 + cookie
const code = totp(SECRET)
console.log('  当前 TOTP 码 =', code)
r = await fetch(BASE + '/__deepc_auth', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'code=' + code,
  redirect: 'manual',
})
const setCookie = r.headers.get('set-cookie') || ''
check('公网 TOTP 码 → 302', r.status === 302, 'status=' + r.status)
check('公网种 dc_site cookie', setCookie.includes('dc_site='))

// 3. 带 cookie → 反代真实 dsh UI
const cookie = setCookie.split(';')[0]
r = await fetch(BASE + '/', { headers: { cookie } })
const body3 = await r.text()
check('公网带 cookie 反代 → 200', r.status === 200, 'status=' + r.status)
check('公网返回真实 dsh UI', body3.includes('Harness') || body3.length > 1000, 'len=' + body3.length)

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
