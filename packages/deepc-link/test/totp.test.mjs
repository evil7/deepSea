// TOTP 实现测试（RFC 6238 标准测试向量 + base32 往返 + 窗口容差）。
// 运行：先 node test/build-tests.mjs，再 node test/totp.test.mjs

import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  otpauthUri,
} from './.totp.bundle.mjs'

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

// ── 1. base32 编解码往返 ─────────────────────────────────────────────
{
  const bytes = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30])
  const enc = base32Encode(bytes)
  check('base32 编码（RFC 4648）', enc === 'GEZDGNBVGY3TQOJQ', `got=${enc}`)
  const dec = base32Decode(enc)
  check(
    'base32 解码往返',
    Buffer.from(dec).equals(Buffer.from(bytes)),
    `got=${Buffer.from(dec).toString('hex')}`,
  )
}

// ── 2. RFC 6238 标准测试向量（secret = 12345678901234567890，SHA1，6 位）────────
// secret 的 base32 形式为 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
{
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  const vectors = [
    [59_000, '287082'], // 0x0000000000000001
    [1_111_111_109_000, '081804'],
    [1_111_111_111_000, '050471'],
    [1_234_567_890_000, '005924'],
    [2_000_000_000_000, '279037'],
    [20_000_000_000_000, '353130'],
  ]
  for (const [t, expected] of vectors) {
    const code = totpCode(secret, t, 30, 6)
    check(`TOTP(t=${t}) = ${expected}`, code === expected, `got=${code}`)
  }
}

// ── 3. verifyTotp 正确码 + 窗口容差 ──────────────────────────────────
{
  const secret = generateTotpSecret()
  const now = Date.now()
  const current = totpCode(secret, now)
  check('verifyTotp 正确码通过', verifyTotp(secret, current, now))
  check('verifyTotp 错误码拒绝', verifyTotp(secret, '000000', now) === false)
  // ±1 步容差
  const prev = totpCode(secret, now - 30_000)
  const next = totpCode(secret, now + 30_000)
  check('verifyTotp 前一步容差通过', verifyTotp(secret, prev, now))
  check('verifyTotp 后一步容差通过', verifyTotp(secret, next, now))
  // 超窗口拒绝
  const far = totpCode(secret, now - 60_000)
  check('verifyTotp 超窗口拒绝', verifyTotp(secret, far, now) === false)
}

// ── 4. 非法输入拒绝 ─────────────────────────────────────────────────
{
  const secret = generateTotpSecret()
  check('非 6 位数字拒绝', verifyTotp(secret, '12345', Date.now()) === false)
  check('含字母拒绝', verifyTotp(secret, '12a456', Date.now()) === false)
}

// ── 5. otpauth URI 格式 ──────────────────────────────────────────────
{
  const uri = otpauthUri('GEZDGNBVGY3TQOJQ', 'my-node')
  check('otpauth URI 含 secret', uri.includes('secret=GEZDGNBVGY3TQOJQ'))
  check('otpauth URI 为 totp 类型', uri.startsWith('otpauth://totp/'))
  check('otpauth URI 含 issuer', uri.includes('issuer=deepc-link'))
  check('otpauth URI 6 位 30s', uri.includes('digits=6') && uri.includes('period=30'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
