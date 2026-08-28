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
 *   · 门禁（二选一）：TOTP 2FA（POST /__deepc_auth，RFC 6238 ±1 步）或主站 bypass
 *     ticket（POST /__deepc_ticket，一次性+短 TTL+nodeId 绑定）。门通过后：
 *       1) 种门通行证 dc_site（SameSite=Strict，7 天，仅 3081 判定"已过门"）
 *       2) 服务端原生 http 交换官方 launch-token（GET 127.0.0.1:3080/?token=，
 *          token 只在本机往返，永不进浏览器 URL/公网）→ 原样透传官方 Set-Cookie
 *          （dsh-auth-*，SameSite=Strict/HttpOnly/host-only 官方定义零改写）
 *       3) 302 回原路径 → 浏览器携带官方 cookie 反代 → 官方裁决会话
 *   · 防暴力：连续失败 5 次锁 1 小时 + 审计日志 + 常量时间比较
 *
 * 会话模型（双 cookie）：dc_site = 门通行证（短 TTL，可刷新）；dsh-auth-* = 官方会话
 * （30 天）。官方 cookie 过期/secret 更换时，3081 把带有效 dc_site 的 index 401
 * 302 到 /__deepc_reauth 重新过门。无 dc_site 的请求不反代（401 鉴权页），伪造 cookie
 * 无法触发任何服务端交换。
 *
 * 老版本 dsh（legacyDsh，无 launch-token）：门通过后仅种 dc_site（自有会话，原行为）。
 *
 * TOTP secret 仅存内存（不落盘），由 host.ts 持久化到 ~/.deepc 并注入；
 * 用户用 2FA 应用扫码绑定，动态码 30s 轮换，最终安全由用户本地掌控。
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { type Duplex } from 'node:stream'
import { hmacSha256Hex, sha512Hex, verifyTotp } from './totp'
import { DEEPSEA_LOGO } from './deepsea-logo'

/** 反代目标：dsh 官方 3080。 */
const UPSTREAM = 'http://127.0.0.1:3080'

/** 鉴权端点路径（手动输入 2FA 码）。 */
const AUTH_PATH = '/__deepc_auth'

/** 重新认证端点（官方会话失效时 3081 内部 302 到这里重新过门）。 */
const REAUTH_PATH = '/__deepc_reauth'

/** 探活 WebSocket 端点（免鉴权，纯 ping/pong echo，供主站前端实时探测节点在线）。 */
const PROBE_PATH = '/__deepc_probe'

/** 主站 bypass 登录端点（免鉴权，但需一次性 ticket 验签）。 */
const TICKET_PATH = '/__deepc_ticket'

/**
 * 免鉴权的公开静态资源路径（浏览器自动请求、无敏感信息：PWA manifest / 站点图标 / robots）。
 * 仅精确路径白名单，不放开通配——避免误放开 /api/*、/deepc/* 等敏感路径。
 */
const PUBLIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/manifest.json',
  '/site.webmanifest',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon.png',
  '/robots.txt',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
])

/**
 * 远端来源标记头：3081 反代时按真实 Host 注入（非 loopback → '1'），供 dsh 后端
 * /deepc/* handleControl 识别「远端访问」并拒绝敏感控制端点（登录/切模式/重生成 TOTP 等）。
 */
const REMOTE_HEADER = 'x-deepc-remote'

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
  /**
   * dsh v0.1.2+ launch-token 浏览器认证适配：返回当前 dsh 进程的 launch token
   * （经 ctx.connection.authenticatedUrl 提取）。老版本 dsh 无此能力 → 返回 null，
   * 反代不启用 token 转发（老版本无 401，直接透传，兼容双版本）。
   */
  getLaunchToken?: () => string | null
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

/** 判断 hostname 是否 loopback（本机 127.0.0.1 / localhost / ::1）。 */
function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
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
function authPage(lockedUntil = 0): string {
  const faviconHref = 'data:image/svg+xml;base64,' + Buffer.from(DEEPSEA_LOGO).toString('base64')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>deepc-link 安全验证</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref}">
<style>
  :root{color-scheme:light dark;
        --font-sans:"Inter","SF Pro Display","SF Pro Text",-apple-system,"Segoe UI",
          "HarmonyOS Sans SC","MiSans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
        --font-mono:"JetBrains Mono","SF Mono","Fira Code","Cascadia Code","Roboto Mono",
          ui-monospace,Menlo,Consolas,monospace}
  body{font-family:var(--font-sans);
       background:var(--bg);color:var(--fg);display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;transition:background .2s ease,color .2s ease}
  :root{--bg:#f3f4f7;--card:#fff;--border:#e5e7eb;--fg:#0f1115;--fg-soft:#61666b;
        --input-bg:#fff;--brand:#16b3eb;--brand-fg:#02080f;--danger:#ec1313;
        --danger-soft:rgba(236,19,19,.08)}
  @media (prefers-color-scheme:dark){
    :root{--bg:#0f1115;--card:#1a1d24;--border:#2a2e38;--fg:#e6e6e6;--fg-soft:#8a8f98;
          --input-bg:#0f1115;--brand:#16b3eb;--brand-fg:#02080f;--danger:#ff6b6b;
          --danger-soft:rgba(255,107,107,.14)}
  }
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;
        padding:28px 32px;max-width:360px;width:100%;box-sizing:border-box;
        box-shadow:0 8px 32px rgba(0,0,0,.08);transition:background .2s ease,border-color .2s ease}
  h1{font-size:18px;font-weight:700;letter-spacing:.01em;margin:0 0 6px}
  .sub{color:var(--fg-soft);font-size:12px;margin:0 0 18px}
  .code{display:flex;gap:7px;justify-content:center;position:relative}
  .code .cell{width:40px;height:48px;box-sizing:border-box;text-align:center;line-height:48px;
        border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:var(--fg);
        font-size:20px;font-family:var(--font-mono);font-variant-numeric:tabular-nums;
        transition:border-color .15s ease,box-shadow .15s ease}
  .code .cell.active{border-color:var(--brand);box-shadow:0 0 0 3px rgba(22,179,235,.18)}
  .code .cell:nth-child(4){margin-left:7px}
  .code.error .cell{border-color:var(--danger)}
  .code.shake{animation:shake .4s ease}
  @keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
  .ghost{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;background:none;
         color:transparent;caret-color:transparent;outline:none}
  .err{color:var(--danger);font-size:12px;min-height:16px;margin-top:12px;text-align:center}
  .hint{color:var(--fg-soft);font-size:12px;margin-top:14px;text-align:center;letter-spacing:.01em}
  .banned{display:flex;flex-direction:column;align-items:center;gap:14px;padding:16px 4px 8px}
  .banned-head{display:flex;align-items:center;gap:10px}
  .banned-icon{width:28px;height:28px;border-radius:8px;background:var(--danger-soft);color:var(--danger);
        display:flex;align-items:center;justify-content:center;flex-shrink:0;
        animation:breathe 2.2s ease-in-out infinite}
  .banned-icon svg{width:16px;height:16px}
  .banned-title{font-size:15px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--fg)}
  .banned-remain{font-family:var(--font-mono);font-size:34px;font-weight:600;line-height:1;
        color:var(--fg);font-variant-numeric:tabular-nums;letter-spacing:.02em}
  .banned-msg{color:var(--fg-soft);font-size:13px;text-align:center;line-height:1.6}
  @keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
</style></head><body data-locked-until="${lockedUntil}">
<div class="card">
  <h1 id="title">deepc-link 安全验证</h1>
  <p class="sub" id="sub">请输入 2FA 应用中的 6 位动态码</p>
  <div class="code" id="codebox">
    <div class="cell"></div>
    <div class="cell"></div>
    <div class="cell"></div>
    <div class="cell"></div>
    <div class="cell"></div>
    <div class="cell"></div>
    <input class="ghost" id="ghost" inputmode="numeric" autocomplete="one-time-code">
  </div>
  <div class="banned" id="banned" style="display:none">
    <div class="banned-head">
      <div class="banned-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
      <div class="banned-title">access denied</div>
    </div>
    <div class="banned-remain" id="banned-remain"></div>
    <div class="banned-msg">连续失败次数过多，已锁定访问</div>
  </div>
  <div class="err" id="err"></div>
  <div class="hint" id="hint">动态码 30s 轮换，由本地 2FA 应用生成</div>
</div>
<script>
  (function () {
    var cells = Array.prototype.slice.call(document.querySelectorAll('.cell'))
    var codebox = document.getElementById('codebox')
    var ghost = document.getElementById('ghost')
    var err = document.getElementById('err')
    var title = document.getElementById('title')
    var sub = document.getElementById('sub')
    var hint = document.getElementById('hint')
    var banned = document.getElementById('banned')
    var bannedRemain = document.getElementById('banned-remain')
    var value = ''
    var submitting = false
    var locked = false

    function fmt(ms) {
      var total = Math.max(0, ms)
      var m = Math.floor(total / 60000)
      var s = Math.floor((total % 60000) / 1000)
      var cs = Math.floor((total % 1000) / 10)
      function pad(n, w) { var str = String(n); while (str.length < w) str = '0' + str; return str }
      return pad(m, 2) + ':' + pad(s, 2) + ':' + pad(cs, 2)
    }

    function ban(ms) {
      locked = true
      var end = Date.now() + ms
      title.style.display = 'none'
      sub.style.display = 'none'
      codebox.style.display = 'none'
      hint.style.display = 'none'
      err.textContent = ''
      banned.style.display = ''
      function tick() {
        var left = end - Date.now()
        if (left <= 0) { window.location.reload(); return }
        bannedRemain.textContent = fmt(left)
        setTimeout(tick, 33)
      }
      tick()
    }

    function render() {
      for (var i = 0; i < cells.length; i++) {
        cells[i].textContent = value[i] || ''
        cells[i].classList.toggle('active', i === value.length && value.length < 6)
      }
    }

    function fail(msg) {
      err.textContent = msg
      codebox.classList.remove('shake')
      void codebox.offsetWidth
      codebox.classList.add('shake', 'error')
      setTimeout(function () {
        value = ''
        codebox.classList.remove('shake', 'error')
        render()
        ghost.focus()
      }, 500)
    }

    function submit() {
      if (value.length !== 6 || submitting) return
      submitting = true
      err.textContent = ''
      fetch('${AUTH_PATH}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'code=' + encodeURIComponent(value),
        redirect: 'follow'
      }).then(function (res) {
        if (res.redirected || res.ok) {
          window.location.reload()
          return null
        }
        return res.json().catch(function () { return {} })
      }).then(function (data) {
        if (data === null) return
        if (data && data.error === 'locked') {
          ban(Math.max(0, (data.lockedUntil || Date.now() + 3600000) - Date.now()))
          return
        }
        fail('动态码错误，可重试 ' + (data && data.remaining > 0 ? data.remaining : 0) + ' 次')
      }).catch(function () {
        fail('网络错误，请重试')
      }).then(function () {
        submitting = false
      })
    }

    ghost.addEventListener('input', function () {
      var digits = ghost.value.replace(/\\D/g, '')
      ghost.value = ''
      if (digits && value.length < 6) {
        value = (value + digits).slice(0, 6)
        render()
        if (value.length === 6) submit()
      }
    })

    ghost.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace') {
        e.preventDefault()
        value = value.slice(0, -1)
        render()
      }
    })

    ghost.addEventListener('paste', function (e) {
      e.preventDefault()
      var t = (e.clipboardData || window.clipboardData).getData('text').replace(/\\D/g, '').slice(0, 6)
      value = t
      render()
      if (value.length === 6) submit()
    })

    codebox.addEventListener('click', function () { ghost.focus() })

    // 防失焦：输入未完成且未提交/锁定时，失焦立即重新聚焦，保证连续按键始终有响应。
    ghost.addEventListener('blur', function () {
      if (submitting || locked) return
      setTimeout(function () { ghost.focus() }, 0)
    })

    var initialLock = Number(document.body.getAttribute('data-locked-until') || '0')
    if (initialLock > Date.now()) {
      ban(initialLock - Date.now())
    } else {
      render()
      ghost.focus()
    }
  })()
</script>
</body></html>`
}

/**
 * 是否 dsh index 请求（v0.1.2+ 仅对根路径 / 与 /index.html 做 launch-token 认证，
 * 静态资源保持公开）。
 */
function isIndexPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html'
}

export function createAuthProxy(opts: AuthProxyOptions = {}): AuthProxy {
  const port = opts.port ?? 3081
  const host = opts.host ?? '0.0.0.0'
  const upstream = opts.upstream ?? UPSTREAM
  const log = opts.log ?? ((m: string) => console.log(`[deepc:3081] ${m}`))

  // 反代实例（HTTP + WS 一体；changeOrigin 让 Host 改写为上游，等价旧 fetch 反代行为）。
  // 运行时 require：确保在 patch-util 替换 util._extend 之后才加载 http-proxy，
  // 使其捕获到的 `extend = require('util')._extend` 已是 Object.assign，消除 DEP0060。
  const httpProxy = createRequire(import.meta.url)('http-proxy') as typeof import('http-proxy')
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
  proxy.on('proxyReq', (proxyReq, req, res) => {
    stripOrigin(proxyReq)
    // 远端来源标记：Host 非 loopback（隧道域名 / 局域网 IP）→ 强制注入 x-deepc-remote，
    // 供 dsh 后端 /deepc/* handleControl 拒绝敏感控制端点（登录/切模式/重生成 TOTP 等
    // 只允许本地面板）。服务端按真实 Host 注入，前端无法伪造（伪造会被 remove/set 覆盖）。
    const hostname = (req.headers.host ?? '').split(':')[0] ?? ''
    if (isLoopbackHostname(hostname)) {
      proxyReq.removeHeader(REMOTE_HEADER)
    } else {
      proxyReq.setHeader(REMOTE_HEADER, '1')
    }

    // SSE/长连接响应：客户端在响应完成前断开（浏览器关 EventSource、cloudflared 取消流）
    // 时主动终止上游请求，避免上游 3080 的 SSE 流因半开连接而悬挂泄漏。
    // http-proxy 内部仅处理 req 'aborted' 与 ECONNRESET 两种情形，优雅关闭（FIN 或其它
    // 错误码，如日志中 cloudflared 报的 "stream canceled by remote with error code 0"）可能
    // 漏掉上游清理，这里按 res 'close' 兜底。仅当响应尚未写完时才 destroy，不影响正常请求。
    if (res && typeof res.once === 'function') {
      res.once('close', () => {
        if (!res.writableEnded && !proxyReq.destroyed) {
          proxyReq.destroy()
        }
      })
    }
  })
  proxy.on('proxyReqWs', stripOrigin)

  // 远端访问统一走「顶层导航/新窗口」（主站 links 直接新标签打开节点），浏览器顶层
  // 上下文即节点域 → 官方 SameSite=Strict launch-token cookie 在第一方上下文正常存储
  // 与发送，**零改写任何官方 cookie 属性**（host-only/HttpOnly/Strict 原样保留）。
  // 不剥离 X-Frame-Options / CSP frame-ancestors——不再 iframe 嵌入，官方安全头原样透传。
  proxy.on('proxyRes', (proxyRes, req) => {
    // [会话刷新] 官方 cookie 失效（过期 / 官方 secret 更换后重启）且本浏览器已过门
    // （带有效 dc_site）→ 同步 302 到 /__deepc_reauth 重新过门（TOTP/ticket → 新交换）。
    // 关键安全边界：无 dc_site 的请求在 3081 层不反代（401 鉴权页），这里 302 只服务
    // 「已过门但官方会话失效」的合法场景；伪造 cookie 触发不了服务端交换（门不通过）。
    if (
      opts.getLaunchToken &&
      proxyRes.statusCode === 401 &&
      req.method === 'GET' &&
      typeof req.url === 'string' &&
      isIndexPath(new URL(req.url, 'http://x').pathname)
    ) {
      const cookies = parseCookies(req)
      const dc = cookies[COOKIE_NAME]
      if (dc && verifyCookie(dc)) {
        proxyRes.statusCode = 302
        proxyRes.headers.location = REAUTH_PATH
        proxyRes.headers['cache-control'] = 'no-store'
      }
    }
  })

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

  /**
   * 生成门通行证 cookie（7 天）。属性按**种入上下文**区分（关键！）：
   *   · crossSite=true（主站 ticket 免密）：ticket 是 deepc.cn 跨站 form POST 到隧道域，
   *     `SameSite=Strict` 在跨站响应中**不会被浏览器存储** → 免密失效（302 后无 dc_site
   *     → 门禁 401 → 显示 TOTP 页）。必须 `SameSite=None; Secure` 才能跨站种入。
   *   · crossSite=false（手动 TOTP）：页面在隧道域/局域网（第一方）提交，`SameSite=Strict`
   *     足够且兼容局域网 http（Secure 需 https，局域网是 http）。
   * dc_site 仅 3081 判定「已过门」；真正会话由官方 dsh-auth-* cookie 承担（新 dsh）。
   */
  function dcSiteCookie(crossSite: boolean): string {
    const exp = Date.now() + 7 * 24 * 3600 * 1000
    const sig = hmacHex(secret!, `deepc-cookie:${exp}`)
    const sameSite = crossSite ? 'SameSite=None; Secure' : 'SameSite=Strict'
    return `${COOKIE_NAME}=${exp}.${sig}; Path=/; HttpOnly; ${sameSite}; Max-Age=${7 * 24 * 3600}`
  }

  /**
   * 服务端代浏览器完成官方 launch-token 交换（dsh v0.1.2+）。
   * 原生 http.request GET `127.0.0.1:3080/?token=<launchToken>`（redirect manual）
   * → 官方 303 + Set-Cookie（authority=127.0.0.1:3080，与反代 changeOrigin 一致）。
   * token 只在本机 127.0.0.1 往返，永不进入浏览器 URL / 公网隧道。
   * @returns 官方 Set-Cookie 数组（原样透传），失败返回 null。
   */
  function exchangeOfficialToken(): Promise<string[] | null> {
    const launchToken = opts.getLaunchToken?.() ?? null
    if (!launchToken) return Promise.resolve(null)
    const u = new URL(upstream)
    return new Promise((resolve) => {
      const r = httpRequest(
        {
          host: u.hostname,
          port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
          path: `/?token=${encodeURIComponent(launchToken)}`,
          method: 'GET',
          headers: { host: u.host },
        },
        (res) => {
          const cookies = res.headers['set-cookie']
          res.resume() // 排空响应体，避免连接悬挂
          if (res.statusCode !== 303) {
            log(`[token] 官方交换异常：HTTP ${String(res.statusCode)}（预期 303）`)
            resolve(null)
            return
          }
          resolve(Array.isArray(cookies) ? cookies : cookies ? [cookies] : null)
        },
      )
      r.on('error', (err: Error) => {
        log(`[token] 官方交换失败：${err.message}`)
        resolve(null)
      })
      r.end()
    })
  }

  /**
   * 门通过后的统一授权动作：种门通行证 dc_site + 服务端交换官方会话 cookie（新 dsh）
   * → 302 回原路径。老版本 dsh（无 launch-token）仅种 dc_site（自有会话回退，原行为）。
   * @param crossSite 种 dc_site 的上下文是否跨站（ticket 免密=true，TOTP 手动=false）。
   */
  async function grantAccess(res: ServerResponse, back: string, crossSite: boolean): Promise<void> {
    const dc = dcSiteCookie(crossSite)
    const official = await exchangeOfficialToken()
    const headers: Record<string, string | string[]> = {
      Location: back,
      'Cache-Control': 'no-store',
    }
    if (official) {
      headers['Set-Cookie'] = [dc, ...official]
    } else {
      if (opts.getLaunchToken) {
        log('[token] 交换失败，会话降级为 dc_site（下次 index 401 将自动重新交换）')
      }
      headers['Set-Cookie'] = dc
    }
    res.writeHead(302, headers)
    res.end()
  }

  /** 处理鉴权 POST（手动输入安全码）。 */
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
      sendJson(res, 429, { ok: false, error: 'locked', lockedUntil })
      return
    }

    if (!verifyCode(input)) {
      auditLog(ip, false)
      const locked = recordFailure()
      if (locked) {
        sendJson(res, 429, { ok: false, error: 'locked', lockedUntil })
        return
      }
      sendJson(res, 401, { ok: false, error: 'bad-code', remaining: LOCK_THRESHOLD - failCount })
      return
    }

    auditLog(ip, true)
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
    await grantAccess(res, back, false)
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
          // ticket 来自主站跨站 form POST → dc_site 必须 None+Secure 才能种入。
          await grantAccess(res, '/', true)
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

    // 重新认证端点（官方会话失效时由 proxyRes 401 同步 302 到这里）：
    // 直接返回鉴权页 + 过期 dc_site，强制重新过门（避免 302 到 / 反代死循环）。
    if (req.method === 'GET' && pathname === REAUTH_PATH) {
      const locked = isLocked()
      // 过期旧 dc_site：浏览器后续请求不再携带，重新走门禁。
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`)
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(authPage(locked ? lockedUntil : 0))
      return
    }

    // 公开静态资源（PWA manifest / 图标 / robots 等浏览器自动请求的无敏感资源）：
    // 免鉴权直接反代，避免浏览器自动请求 manifest.webmanifest 被 401 拦截。
    if (req.method === 'GET' && PUBLIC_PATHS.has(pathname)) {
      proxy.web(req, res)
      return
    }

    // 无 cookie → 401 + 鉴权页（页面内嵌，无外部资源）
    const cookies = parseCookies(req)
    const dc = cookies[COOKIE_NAME]
    if (!dc || !verifyCookie(dc)) {
      const locked = isLocked()
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(authPage(locked ? lockedUntil : 0))
      return
    }

    // 其余 → 反代到 dsh
    proxy.web(req, res)
  })

  // —— 关键修复：对齐 cloudflared 的 origin 连接复用周期 ——
  // node http server 默认 keepAliveTimeout=5s，远小于 cloudflared 到 origin 的
  // IdleConnTimeout（默认 90s）。cloudflared 会在 90s 内复用连接，但 node 5s 后就把
  // 空闲 keep-alive 连接关闭；cloudflared 复用「半死」连接时，POST 请求（如
  // /api/agentPreset.list 这类 RPC）RoundTrip 失败，而 Go http.Transport 对非幂等 POST
  // 不自动重试 → 直接向浏览器返回 HTTP 530（"Unable to reach the origin service"）。
  // 把 node 的 keepAliveTimeout 提升到 >90s，避免 node 在 cloudflared 复用前主动关连接。
  // headersTimeout 必须 ≥ keepAliveTimeout（否则 node 告警且行为异常）。
  server.keepAliveTimeout = 120_000
  server.headersTimeout = 125_000

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
