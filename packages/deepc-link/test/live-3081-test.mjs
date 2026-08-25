// 真实 3081 鉴权流程测试（连接本地已启动的 3081 鉴权代理）
import { createHmac } from 'node:crypto'

const SECRET = '7TQMUQZ6RTLE4IK7AS2C2Z2HIX2X6VHY'
const BASE = 'http://127.0.0.1:3081'

// TOTP 计算（RFC 6238）
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

// 1. 无 cookie → 401 + 鉴权页
let r = await fetch(BASE + '/', { redirect: 'manual' })
const body1 = await r.text()
check('无 cookie → 401', r.status === 401, 'status=' + r.status)
check('返回 6 位 2FA 鉴权页', body1.includes('deepc-link 安全验证') && body1.includes('6 位动态码'))

// 2. 错误 TOTP 码 → 401
r = await fetch(BASE + '/__deepc_auth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=000000', redirect: 'manual' })
const body2 = await r.text()
check('错误 TOTP 码 → 401', r.status === 401 && body2.includes('bad-code'), 'status=' + r.status)

// 3. 正确 TOTP 码 → 302 + dc_site cookie
const code = totp(SECRET)
console.log('  当前 TOTP 码 =', code)
r = await fetch(BASE + '/__deepc_auth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=' + code, redirect: 'manual' })
const setCookie = r.headers.get('set-cookie') || ''
check('正确 TOTP 码 → 302', r.status === 302, 'status=' + r.status)
check('种 dc_site cookie（Partitioned）', setCookie.includes('dc_site=') && setCookie.includes('Partitioned'))

// 4. 带 cookie → 反代真实 dsh 3080（返回 DeepSeek Harness 页面）
const cookie = setCookie.split(';')[0]
r = await fetch(BASE + '/', { headers: { cookie } })
const body4 = await r.text()
check('带 cookie 反代 3080 → 200', r.status === 200, 'status=' + r.status)
check('返回真实 dsh UI', body4.includes('Harness') || body4.includes('DeepSeek') || body4.length > 1000)

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
