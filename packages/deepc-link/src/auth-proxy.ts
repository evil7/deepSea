/**
 * deepc-link 3081 鉴权代理 —— 独立轻量鉴权 webserver（方案核心）。
 *
 * 背景：dsh 官方 webServer 无全局中间件（fallback 单席位被 frontend-static 占用），
 * 无法注入全局鉴权 → 插件自持独立 3081，经 cloudflared ingress catch-all 接流量，
 * 反代到 dsh 3080。
 *
 * 职责：
 *   · HTTP 反代 3080（path/headers/body 原样透传）
 *   · WebSocket 透传（WS hijack 双向转发）
 *   · TOTP 2FA 鉴权：无 dc_site cookie → 401 + 内置鉴权页 → POST /__deepc_auth
 *     （6 位动态码，RFC 6238 校验，±1 时间步容差）→ Set-Cookie dc_site
 *     （Partitioned）→ 302 回原路径
 *   · 防暴力：连续失败 5 次锁 1 小时（secret 级全局，remoteAddress 恒为本地
 *     cloudflared/局域网，基于 IP 限速无效）+ 审计日志 + 常量时间比较
 *
 * TOTP secret 仅存内存（不落盘），由 host.ts 持久化到 ~/.deepc 并注入；
 * 用户用 2FA 应用扫码绑定，动态码 30s 轮换，最终安全由用户本地掌控。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { type Duplex } from 'node:stream'
import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import httpProxy from 'http-proxy'
import { hmacSha256Hex, sha512Hex, verifyTotp } from './totp'

/** 反代目标：dsh 官方 3080。 */
const UPSTREAM = 'http://127.0.0.1:3080'

/** 鉴权端点路径（手动输入 2FA 码）。 */
const AUTH_PATH = '/__deepc_auth'

/** 探活 WebSocket 端点（免鉴权，纯 ping/pong echo，供主站前端实时探测节点在线）。 */
const PROBE_PATH = '/__deepc_probe'

/** 主站 bypass 登录端点（免鉴权，但需一次性 ticket 验签）。 */
const TICKET_PATH = '/__deepc_ticket'

/** 鉴权代理自定义 API 前缀（需 dc_site cookie；本地目录枚举，供远端路径选择 UI 用）。 */
const API_PATH = '/__deepc_api'

/** ticket 时效（毫秒）：主站签发后 30s 内有效。 */
const TICKET_TTL_MS = 30_000

/** WebSocket 握手魔法串（RFC 6455）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 鉴权 cookie 名。 */
const COOKIE_NAME = 'dc_site'

/** 连续失败锁定阈值。 */
const LOCK_THRESHOLD = 5
/** 锁定时长（毫秒）：失败 5 次锁 1 小时。 */
const LOCK_MS = 60 * 60_000

export interface AuthProxyOptions {
  /** 监听端口（默认 3081）。 */
  port?: number
  /** 监听地址（默认 0.0.0.0，局域网可达；模式2/3 由 cloudflared 转发）。 */
  host?: string
  /** 反代上游（默认 3080）。 */
  upstream?: string
  /** 日志回调（默认 console）。 */
  log?: (msg: string) => void
}

export interface AuthProxy {
  /** 注入 TOTP secret（connect 时由 host.ts 从 ~/.deepc 载入）。 */
  setSecret: (secret: string) => void
  /** 当前 TOTP secret（状态展示用）。 */
  getSecret: () => string | null
  /** 注入主站 bypass 配置（nodeId 非 null 即启用免密直连；null 关闭）。 */
  setBypass: (nodeId: string | null) => void
  /** 启动监听。 */
  start: () => Promise<void>
  /** 停止监听。 */
  stop: () => Promise<void>
}

/** HMAC-SHA256（hex），密钥 = TOTP secret。 */
function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}

/** 常量时间字符串比较（长度不同直接 false，防长度泄漏）。 */
function constantEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** 反代出站请求前剥离 Origin（dsh 对非本地 Origin 做 CSRF 校验返回 403）。 */
function stripOrigin(proxyReq: import('node:http').ClientRequest): void {
  proxyReq.removeHeader('Origin')
}

// ---------------------------------------------------------------------------
// WebSocket 帧解析/构造（仅探活端点用；RFC 6455，无扩展、无分片，探活帧极小）
// ---------------------------------------------------------------------------

interface WsFrame {
  opcode: number
  payload: Buffer
  /** 该帧在缓冲区中的总字节数（头 + payload）。 */
  length: number
}

/** 解析一个客户端 WS 帧（masked）。缓冲区不足一帧时返回 null（等待更多数据）。 */
function parseWsFrame(buf: Buffer): WsFrame | null {
  if (buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  let maskKey: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.slice(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  let payload = buf.slice(offset, offset + len)
  if (masked && maskKey) {
    const unmasked = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4]
    payload = unmasked
  }
  return { opcode, payload, length: offset + len }
}

/** 构造一个服务端 WS 帧（unmasked，文本/二进制/ping/pong/close）。 */
function buildWsFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** 处理探活 WS：完成握手，随后 ping→pong、text→回 "pong"、close→关闭。 */
function handleProbeWs(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  // 探活 echo：收到 ping 回 pong；收到 text 回文本 "pong"；收到 close 关闭。
  let buffer = head && head.length ? head : Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const frame = parseWsFrame(buffer)
      if (!frame) break
      buffer = buffer.slice(frame.length)
      if (frame.opcode === 0x9) {
        // ping → pong
        socket.write(buildWsFrame(frame.payload, 0xa))
      } else if (frame.opcode === 0x1) {
        // 任意文本 → 回 "pong"
        socket.write(buildWsFrame(Buffer.from('pong'), 0x1))
      } else if (frame.opcode === 0x8) {
        // close → 回 close 帧并断开
        socket.write(buildWsFrame(Buffer.alloc(0), 0x8))
        socket.end()
        return
      }
      // 其它帧（binary/continuation）忽略
    }
  })
  socket.on('error', () => socket.destroy())
}

// ---------------------------------------------------------------------------
// /__deepc_api/* —— 本地目录枚举（需 dc_site 鉴权；远端路径选择 UI 的数据源）
// ---------------------------------------------------------------------------

/** 目录枚举上限（防大目录拖垮；与 dsh browse 后端一致取 1000）。 */
const DIR_MAX_ENTRIES = 1000

interface DirCrumb {
  name: string
  path: string
  hidden: boolean
}

interface DirEntry {
  name: string
  path: string
  hidden: boolean
}

/** 从根到 target 的祖先链（面包屑行）。 */
function ancestryCrumbs(target: string): DirCrumb[] {
  const crumbs: DirCrumb[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    crumbs.unshift({
      name: parent === current ? current : basename(current),
      path: current,
      hidden: false,
    })
    if (parent === current) return crumbs
    current = parent
  }
}

/** 枚举单层子目录（符号链接跟随判定，断链/循环跳过）。 */
async function listDirectory(
  path: string | undefined,
): Promise<{
  ok: true
  path: string
  home: string
  crumbs: DirCrumb[]
  entries: DirEntry[]
  truncated: boolean
}> {
  const home = homedir()
  const target = resolve(path && path.trim() ? path : home)
  const raw: DirEntry[] = []
  const dir = await opendir(target)
  for await (const dirent of dir) {
    let enterable = dirent.isDirectory()
    if (!enterable && dirent.isSymbolicLink()) {
      try {
        enterable = (await stat(join(target, dirent.name))).isDirectory()
      } catch {
        /* 断链/循环链接跳过 */
      }
    }
    if (!enterable) continue
    raw.push({
      name: dirent.name,
      path: join(target, dirent.name),
      hidden: dirent.name.startsWith('.'),
    })
    if (raw.length > DIR_MAX_ENTRIES) break
  }
  raw.sort((a, b) => a.name.localeCompare(b.name))
  return {
    ok: true,
    path: target,
    home,
    crumbs: ancestryCrumbs(target),
    entries: raw.slice(0, DIR_MAX_ENTRIES),
    truncated: raw.length > DIR_MAX_ENTRIES,
  }
}

/** 在 parent 下创建单层子目录（名称为单段路径）。 */
async function createDirectory(
  path: string,
  name: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    return { ok: false, error: 'invalid-name' }
  }
  const parent = resolve(path)
  const target = join(parent, name)
  try {
    await mkdir(target)
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'mkdir-failed' }
  }
}

/** 处理 /__deepc_api/*（已通过 dc_site 鉴权）。 */
async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const u = new URL(req.url ?? '/', 'http://x')
  const pathname = u.pathname
  if (req.method === 'GET' && pathname === `${API_PATH}/list-dir`) {
    try {
      sendJson(res, 200, await listDirectory(u.searchParams.get('path') ?? undefined))
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : 'list-failed' })
    }
    return
  }
  if (req.method === 'POST' && pathname === `${API_PATH}/create-dir`) {
    const raw = await readBody(req)
    let path = ''
    let name = ''
    try {
      const parsed = JSON.parse(raw) as { path?: string; name?: string }
      path = parsed.path ?? ''
      name = parsed.name ?? ''
    } catch {
      /* ignore */
    }
    sendJson(res, 200, await createDirectory(path, name))
    return
  }
  sendJson(res, 404, { ok: false, error: 'unknown-api' })
}

/** 简单 JSON 响应。 */
function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 读请求 body（限制大小）。 */
function readBody(req: IncomingMessage, max = 16 * 1024): Promise<string> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > max) {
        resolve('')
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })
}

/** 解析 cookie（简易）。 */
function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  const header = req.headers.cookie
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/** 内置鉴权页（极简，无外部依赖；6 位 2FA 码分组输入 `[][][] [][][]`）。 */
function authPage(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>deepc-link 安全验证</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;
        padding:28px 32px;max-width:360px;width:100%;box-sizing:border-box}
  h1{font-size:16px;margin:0 0 6px}
  .sub{color:#8a8f98;font-size:12px;margin:0 0 18px}
  .code{display:flex;gap:8px;justify-content:center}
  .code input{width:40px;height:48px;box-sizing:border-box;text-align:center;
        border-radius:8px;border:1px solid #2a2e38;background:#0f1115;color:#e6e6e6;
        font-size:20px;font-family:ui-monospace,monospace;outline:none}
  .code input:focus{border-color:#4f6ef7}
  .code .sep{display:flex;align-items:center;color:#8a8f98;font-size:20px}
  button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;
         background:#4f6ef7;color:#fff;font-size:14px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .err{color:#ff6b6b;font-size:12px;min-height:16px;margin-top:10px;text-align:center}
  .hint{color:#8a8f98;font-size:12px;margin-top:14px;text-align:center}
</style></head><body>
<div class="card">
  <h1>deepc-link 安全验证</h1>
  <p class="sub">请输入 2FA 应用中的 6 位动态码</p>
  <form method="post" action="${AUTH_PATH}" id="f">
    <input type="hidden" name="code" id="code">
    <div class="code">
      <input type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code" id="c0" autofocus>
      <input type="text" inputmode="numeric" maxlength="1" id="c1">
      <input type="text" inputmode="numeric" maxlength="1" id="c2">
      <span class="sep">-</span>
      <input type="text" inputmode="numeric" maxlength="1" id="c3">
      <input type="text" inputmode="numeric" maxlength="1" id="c4">
      <input type="text" inputmode="numeric" maxlength="1" id="c5">
    </div>
    <button type="submit" id="btn" disabled>进入</button>
    <div class="err" id="err"></div>
  </form>
  <div class="hint">动态码 30s 轮换，由你本地 2FA 应用生成</div>
</div>
<script>
  (function () {
    var inputs = ['c0','c1','c2','c3','c4','c5'].map(function (id) { return document.getElementById(id) })
    var hidden = document.getElementById('code')
    var btn = document.getElementById('btn')
    function sync() {
      var v = inputs.map(function (i) { return i.value }).join('')
      hidden.value = v
      btn.disabled = v.length !== 6
    }
    inputs.forEach(function (inp, idx) {
      inp.addEventListener('input', function () {
        inp.value = inp.value.replace(/\\D/g, '')
        sync()
        if (inp.value && idx < 5) inputs[idx + 1].focus()
      })
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !inp.value && idx > 0) inputs[idx - 1].focus()
      })
      inp.addEventListener('paste', function (e) {
        e.preventDefault()
        var t = (e.clipboardData || window.clipboardData).getData('text').replace(/\\D/g, '').slice(0, 6)
        t.split('').forEach(function (c, i) { if (inputs[i]) inputs[i].value = c })
        sync()
      })
    })
  })()
</script>
</body></html>`
}

export function createAuthProxy(opts: AuthProxyOptions = {}): AuthProxy {
  const port = opts.port ?? 3081
  const host = opts.host ?? '0.0.0.0'
  const upstream = opts.upstream ?? UPSTREAM
  const log = opts.log ?? ((m: string) => console.log(`[deepc:3081] ${m}`))

  // 反代实例（HTTP + WS 一体；changeOrigin 让 Host 改写为上游，等价旧 fetch 反代行为）。
  const proxy = httpProxy.createProxyServer({ target: upstream, changeOrigin: true, ws: true })
  proxy.on('error', (err: Error, _req, res) => {
    // 反代错误兜底：防止 error 冒泡成进程级 unhandledRejection（触发 dsh fail-loud 退出）。
    log(`[proxy] 反代错误：${err.message}`)
    if (!res) return
    if (typeof (res as ServerResponse).writeHead === 'function') {
      const r = res as ServerResponse
      if (!r.headersSent) sendJson(r, 502, { ok: false, error: 'proxy-error' })
      else r.end()
    } else if (typeof (res as { destroy?: () => void }).destroy === 'function') {
      ;(res as { destroy: () => void }).destroy?.()
    }
  })

  // 剥离 Origin：dsh 对非本地 Origin（trycloudflare 隧道域名 / 局域网 IP 等）做 CSRF
  // 校验返回 403。反代时去掉 Origin，上游视为非浏览器请求（无 Origin 已验证 200/101 通过）。
  // 浏览器经隧道访问时页面与请求同域，不依赖 CORS，剥离 Origin 无副作用。
  proxy.on('proxyReq', stripOrigin)
  proxy.on('proxyReqWs', stripOrigin)

  /** TOTP secret（仅内存，由 host.ts 从 ~/.deepc 载入注入）。 */
  let secret: string | null = null

  /** 主站 bypass：本节点 nodeId（null = 关闭免密直连）。 */
  let bypassNodeId: string | null = null
  /** 已用一次性 nonce（防重放；保留最近 1000 个）。 */
  const usedNonces = new Set<string>()

  /** 连续失败计数。 */
  let failCount = 0
  /** 锁定到期时间戳（0 = 未锁定）。 */
  let lockedUntil = 0
  /** 审计日志（内存环形缓冲，最近 50 条）。 */
  const audit: { at: number; ip: string; ok: boolean }[] = []

  function pruneAudit(): void {
    while (audit.length > 50) audit.shift()
  }

  /** 尝试前检查：被锁 → 拒绝。 */
  function isLocked(now = Date.now()): boolean {
    if (lockedUntil === 0) return false
    if (now >= lockedUntil) {
      lockedUntil = 0
      return false
    }
    return true
  }

  /** 记录一次失败 → 连败 5 次锁 1 小时。 */
  function recordFailure(): boolean {
    failCount++
    if (failCount >= LOCK_THRESHOLD) {
      lockedUntil = Date.now() + LOCK_MS
      failCount = 0
      log(`[security] 连败 ${LOCK_THRESHOLD} 次，锁定 ${LOCK_MS / 1000 / 60} 分钟`)
      return true
    }
    return false
  }

  function auditLog(ip: string, ok: boolean): void {
    audit.push({ at: Date.now(), ip, ok })
    pruneAudit()
  }

  /** 校验 6 位 TOTP 动态码（成功即重置连败计数）。 */
  function verifyCode(input: string): boolean {
    if (!secret) return false
    if (!verifyTotp(secret, input)) return false
    failCount = 0 // 成功重置
    return true
  }

  /** 校验 cookie（dc_site = HMAC(secret, exp).exp，7 天）。 */
  function verifyCookie(cookie: string): boolean {
    if (!secret) return false
    const parts = cookie.split('.')
    if (parts.length !== 2) return false
    const [exp, sig] = parts
    const expNum = Number(exp)
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false
    const expect = hmacHex(secret, `deepc-cookie:${exp}`)
    return constantEqual(sig, expect)
  }

  /**
   * 校验主站 bypass ticket（一次性 + 短 TTL + nodeId 绑定）。
   * 主站用 sha512(secret) 作密钥签 HMAC；插件本地重算 sha512(secret) 验签，
   * secret 明文不出本地，主站不存 secret —— 满足「不共享 secret」红线。
   */
  function verifyTicket(body: Record<string, unknown>): boolean {
    if (!secret || !bypassNodeId) return false
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
    if (nodeId !== bypassNodeId) return false
    const ts = typeof body.ts === 'number' ? body.ts : Number(body.ts)
    if (!Number.isFinite(ts) || Date.now() - ts > TICKET_TTL_MS || ts > Date.now() + 5_000) {
      return false
    }
    const nonce = typeof body.nonce === 'string' ? body.nonce : ''
    const sig = typeof body.sig === 'string' ? body.sig : ''
    if (!nonce || !sig) return false
    if (usedNonces.has(nonce)) return false
    const expect = hmacSha256Hex(sha512Hex(secret), `deepc-ticket:${nodeId}:${ts}:${nonce}`)
    if (!constantEqual(sig, expect)) return false
    usedNonces.add(nonce)
    // 保留最近 1000 个 nonce，防内存无限增长。
    if (usedNonces.size > 1000) {
      const it = usedNonces.values()
      for (let i = 0; i < usedNonces.size - 1000; i++) {
        const oldest = it.next().value
        if (oldest !== undefined) usedNonces.delete(oldest)
      }
    }
    return true
  }

  /** 种 cookie 的 Set-Cookie 头（Partitioned = 第三方 iframe 上下文必需）。 */
  function setCookieHeader(res: ServerResponse): void {
    const exp = Date.now() + 7 * 24 * 3600 * 1000
    const sig = hmacHex(secret!, `deepc-cookie:${exp}`)
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${exp}.${sig}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${7 * 24 * 3600}`,
    )
  }

  /** 处理鉴权 POST（手动输入安全码 / iframe auto-post ticket）。 */
  async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = Date.now()
    const ip = req.socket.remoteAddress ?? 'unknown'
    const body = await readBody(req)
    let input = ''
    try {
      const parsed = new URLSearchParams(body)
      input = (parsed.get('code') ?? '').trim()
    } catch {
      input = ''
    }

    if (isLocked(now)) {
      auditLog(ip, false)
      sendJson(res, 429, { ok: false, error: 'locked' })
      return
    }

    if (!verifyCode(input)) {
      auditLog(ip, false)
      if (recordFailure()) {
        sendJson(res, 429, { ok: false, error: 'locked' })
        return
      }
      sendJson(res, 401, { ok: false, error: 'bad-code' })
      return
    }

    auditLog(ip, true)
    // 种 cookie + 302 回原路径
    setCookieHeader(res)
    const origin = req.headers.referer
    let back = '/'
    if (origin) {
      try {
        const u = new URL(origin)
        back = u.pathname + (u.search || '')
      } catch {
        back = '/'
      }
    }
    res.writeHead(302, { Location: back, 'Cache-Control': 'no-store' })
    res.end()
  }

  // HTTP/WS 反代统一交给 http-proxy（成熟的 hop-by-hop 头处理、body 流式、连接清理、WS 双向），
  // 消除手写 fetch 反代 / hijack 的脆弱点（body reader 无 catch、POST body 丢失、半开连接悬挂）。

  const server = createServer((req, res) => {
    // —— 鉴权判定 ——
    const pathname = new URL(req.url ?? '/', 'http://x').pathname

    // 主站 bypass 登录端点（免鉴权，但需一次性 ticket 验签；form urlencoded POST）。
    if (req.method === 'POST' && pathname === TICKET_PATH) {
      void (async () => {
        const raw = await readBody(req)
        let fields: Record<string, unknown> = {}
        try {
          const p = new URLSearchParams(raw)
          fields = {
            nodeId: p.get('nodeId') ?? '',
            ts: Number(p.get('ts') ?? ''),
            nonce: p.get('nonce') ?? '',
            sig: p.get('sig') ?? '',
          }
        } catch {
          /* ignore */
        }
        if (verifyTicket(fields)) {
          setCookieHeader(res)
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' })
          res.end()
        } else {
          sendJson(res, 401, { ok: false, error: 'bad-ticket' })
        }
      })()
      return
    }

    // 鉴权端点本身免鉴权（否则死循环）
    if (req.method === 'POST' && pathname === AUTH_PATH) {
      void handleAuth(req, res)
      return
    }

    // 无 cookie → 401 + 鉴权页（页面内嵌，无外部资源）
    const cookies = parseCookies(req)
    const dc = cookies[COOKIE_NAME]
    if (!dc || !verifyCookie(dc)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(authPage())
      return
    }

    // 已鉴权的自定义 API（本地目录枚举，供远端路径选择 UI）
    if (pathname.startsWith(`${API_PATH}/`)) {
      void handleApi(req, res)
      return
    }

    // 其余 → 反代到 dsh
    proxy.web(req, res)
  })

  // WebSocket upgrade：探活端点免鉴权（纯 ping/pong）；其余鉴权通过才 hijack
  server.on('upgrade', (req, socket, head) => {
    // 防 unhandled socket error：http-proxy 在上游拒绝 WS（非 101，走 res.pipe 路径）时
    // 不会给源 socket 挂 error handler，客户端半开/断开触发 ECONNRESET 会冒泡成进程崩溃。
    socket.on('error', () => socket.destroy())

    const pathname = new URL(req.url ?? '/', 'http://x').pathname

    // 探活端点（免鉴权）：前端 /links 用 ping/pong 实时判定节点在线。
    if (pathname === PROBE_PATH) {
      handleProbeWs(req, socket, head)
      return
    }

    const cookies = parseCookies(req)
    const dc = cookies[COOKIE_NAME]
    if (!dc || !verifyCookie(dc)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    proxy.ws(req, socket, head)
  })

  return {
    setSecret(next) {
      secret = next
      failCount = 0
      lockedUntil = 0
      log('[security] TOTP secret 已注入（连败/锁定计数重置）')
    },
    getSecret() {
      return secret
    },
    setBypass(nodeId) {
      bypassNodeId = nodeId
      if (nodeId) log(`[security] 主站免密已启用（nodeId=${nodeId.slice(0, 8)}…）`)
      else log('[security] 主站免密已关闭')
    },
    start() {
      return new Promise<void>((resolve, reject) => {
        // 幂等：已监听则直接返回（避免重复 listen 触发 EADDRINUSE）。
        if (server.listening) {
          resolve()
          return
        }
        const onError = (err: Error): void => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          log(`鉴权代理已启动 ${host}:${port} → ${upstream}`)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    },
    stop() {
      return new Promise<void>((resolve) => {
        // 幂等：未监听则直接返回（server.close() 对未监听实例会抛 ERR_SERVER_NOT_RUNNING）。
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    },
  }
}
