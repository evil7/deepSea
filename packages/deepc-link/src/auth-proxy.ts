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

import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { verifyTotp } from './totp'

/** 反代目标：dsh 官方 3080。 */
const UPSTREAM = 'http://127.0.0.1:3080'

/** 鉴权端点路径（手动输入 2FA 码）。 */
const AUTH_PATH = '/__deepc_auth'

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

  /** TOTP secret（仅内存，由 host.ts 从 ~/.deepc 载入注入）。 */
  let secret: string | null = null

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

  /** 反代到 3080（HTTP）。 */
  function proxyHttp(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? '/', upstream)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue
      if (k.toLowerCase() === 'host' || k.toLowerCase() === 'set-cookie') continue
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item)
      } else {
        headers.set(k, v)
      }
    }
    const init: RequestInit = Object.assign(
      {
        method: req.method ?? 'GET',
        headers,
        body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : (req as any).body,
        redirect: 'manual' as const,
      },
      { duplex: 'half' },
    )
    fetch(u, init)
      .then((upRes) => {
        res.writeHead(upRes.status, {
          'content-type': upRes.headers.get('content-type') ?? 'text/plain; charset=utf-8',
          ...Object.fromEntries(
            [...upRes.headers.entries()].filter(
              ([k]) => !['content-type', 'transfer-encoding', 'connection'].includes(k.toLowerCase()),
            ),
          ),
        })
        const body = upRes.body
        if (body) {
          const reader = body.getReader()
          const pump = (): void => {
            reader.read().then(({ done, value }) => {
              if (done) {
                res.end()
                return
              }
              res.write(Buffer.from(value))
              pump()
            })
          }
          pump()
        } else {
          res.end()
        }
      })
      .catch(() => {
        if (!res.headersSent) {
          sendJson(res, 502, { ok: false, error: 'upstream-unreachable' })
        } else {
          res.end()
        }
      })
  }

  /** 反代 WebSocket（hijack 双向转发到 3080，用 http.request upgrade 事件）。 */
  function proxyWs(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const u = new URL(req.url ?? '/', upstream)
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v || k.toLowerCase() === 'host') continue
      headers[k] = v
    }
    const upReq = request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method ?? 'GET',
        headers,
      },
      (upRes) => {
        // 上游返回非 101 → 透传状态并关闭
        socket.write(
          `HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ''}\r\n`,
        )
        socket.end()
        upRes.resume()
      },
    )
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `${Object.entries(upRes.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`)
            .join('')}` +
          `\r\n`,
      )
      if (head && head.length) upSocket.write(head)
      if (upHead && upHead.length) socket.write(upHead)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    upReq.on('error', () => socket.destroy())
    upReq.end(head.length ? head : undefined)
  }

  const server = createServer((req, res) => {
    // —— 鉴权判定 ——
    const pathname = new URL(req.url ?? '/', 'http://x').pathname

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

    // 已鉴权 → 反代
    proxyHttp(req, res)
  })

  // WebSocket upgrade：鉴权通过才 hijack
  server.on('upgrade', (req, socket, head) => {
    const cookies = parseCookies(req)
    const dc = cookies[COOKIE_NAME]
    if (!dc || !verifyCookie(dc)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    proxyWs(req, socket, head)
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
