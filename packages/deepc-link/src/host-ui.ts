/**
 * deepc-link 插件端悬浮球 UI —— deepSea 图标悬浮球（右下角）+ 变形 Sheet。
 *
 * 跑在本地 dsh 前端（browser 端 cordis 插件）。用原生 DOM + 注入独立命名空间
 * CSS 实现，不依赖 dsh 前端的样式系统，避免污染官方 UI。动效用 animejs。
 *
 * 交互（递进式升级设置，见 docs/deepsea-tunnel-bridge-proposal.md）：
 *   1. 本地共享 —— 默认基线：启动 3081（TOTP 2FA），局域网访问，始终可用
 *   2. 隧道映射 —— 开关升级：再启动 cloudflared（匿名 Quick Tunnel / 自定义域）
 *   3. 主站纳管 —— 登录升级：登录 deepc 主站上报 URL，断链自动重连上报
 *   悬浮球直接显示 6 位 TOTP 动态码（本地即 2FA 客户端），可展开二维码绑定外部应用。
 *
 * 前端**只做展示 + 控制**：连接/断开/隧道开关/登录均经 `/deepc/*` 调插件后端（node）。
 * TOTP secret 由后端生成并返回（node 内存 + chmod 600 文件）；前端仅用其**展示**
 * 动态码与二维码（不派生新 secret、不启动隧道/鉴权）。
 */

import { animate } from 'animejs'

/** base32 → 字节（浏览器端，与 node 端 totp.ts 同算法，仅用于展示动态码）。 */
function base32Decode(str: string): Uint8Array<ArrayBuffer> {
  const cleaned = str.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 浏览器端 TOTP 动态码（RFC 6238 HMAC-SHA1，Web Crypto；仅用于悬浮球展示）。 */
async function browserTotpCode(secret: string, time = Date.now()): Promise<string> {
  const counter = Math.floor(time / 1000 / 30)
  const key = base32Decode(secret)
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg))
  const offset = sig[sig.length - 1] & 0x0f
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff)
  const code = binary % 1_000_000
  return code.toString().padStart(6, '0')
}

/** 后端控制路由基址（与 host.ts 的 NODE_CTRL_PATH 一致；同源 3080）。 */
const DEEPC_CTRL_BASE = '/deepc'

/** 调用插件后端控制端点。remote=true 声明远端上下文（后端据此裁剪敏感字段，不下发 TOTP secret）。 */
async function deepcCall<T>(action: string, body?: unknown, remote = false): Promise<T | null> {
  try {
    const res = await fetch(`${DEEPC_CTRL_BASE}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote ? { 'X-Deepc-Remote': '1' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** 后端状态（对齐 host.ts 的 DeepcHostStatus）。 */
interface BackendStatus {
  mode: 'local' | 'tunnel' | 'managed'
  loggedIn: boolean
  deviceName: string
  connected: boolean
  url: string | null
  localUrl: string | null
  localOn: boolean
  totpSecret: string | null
  otpauthUri: string | null
  devMode?: boolean
  allowBypass?: boolean
  connectedAt?: number | null
  /** 隧道映射状态机（off/待下载/下载中/已下载/启动中/已启动/已纳管）。 */
  tunnelState?: 'off' | 'download-pending' | 'downloading' | 'downloaded' | 'starting' | 'running' | 'managed'
  profile?: { login: string; avatar_url: string; name: string | null }
  error?: string
}

/** 悬浮球 + sheet + 触发热区根节点 id（幂等守卫）。 */
const HOST_ZONE_ID = '__deepc_bridge_zone'
const FAB_ID = '__deepc_bridge_fab'
const SHEET_ID = '__deepc_bridge_sheet'
const TRIGGER_ID = '__deepc_bridge_trigger'

/** deepSea 品牌图标（内联 SVG，蓝色圆角底 + 三波浪线，与主站 deepsea.svg 一致）。 */
const DEEPSEA_LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6.5" fill="#16b3eb"/><g transform="translate(4 4) scale(0.6667)" stroke="#02080f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12 q2.5 2 5 0 t5 0 t5 0 t5 0"/><path d="M2 19 q2.5 2 5 0 t5 0 t5 0 t5 0"/><path d="M2 5 q2.5 2 5 0 t5 0 t5 0 t5 0"/></g></svg>`

/** 二维码 icon（内联 SVG；front-end token 一致的主站深度蓝）。 */
const QR_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v7M14 21h3M18.5 18H21"/></svg>`

/** 用户 icon（登录按钮，user circle；登录后替换为实际头像）。 */
const USER_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6"/></svg>`

/** 复制 icon（内联 SVG，lucide copy）。 */
const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`

/** 对勾 icon（复制成功反馈）。 */
const CHECK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`

/** 现代简约设计 token（移植 shadcn 语义到 vanilla DOM，插件端不依赖 React/Tailwind）。 */
const CSS = `
/* dsh 的 --dsw-alias-* 变量挂在 body 上（html 上为空），故中转变量也需定义在 body，
   否则 :root(html) 引用不到 body 的变量会退回 fallback。fab/sheet 均为 body 直接子节点，可继承。 */
body {
  /* 背景层级：跟随本地 dsh 明暗主题（body[data-ds-dark-theme] 自动切换）。 */
  --dc-bg: var(--dsw-alias-bg-layer-2, rgba(12, 16, 28, .98));
  --dc-bg-soft: var(--dsw-alias-bg-layer-1, rgba(20, 26, 42, .75));
  --dc-card: var(--dsw-alias-bg-base, rgba(255, 255, 255, .025));
  --dc-card-hover: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .05));
  /* 边框：跟随 dsh。 */
  --dc-border: var(--dsw-alias-border-l2, rgba(148, 163, 184, .14));
  --dc-border-strong: var(--dsw-alias-border-l3, rgba(148, 163, 184, .26));
  /* 文字：跟随 dsh。 */
  --dc-fg: var(--dsw-alias-label-primary, #e6ebf2);
  --dc-fg-soft: var(--dsw-alias-label-secondary, #9aa6b8);
  --dc-fg-dim: var(--dsw-alias-label-tertiary, #6b7688);
  /* 品牌强调色：deepSea 蓝（明暗一致，与悬浮球 logo 一致，不随主题翻转）。 */
  --dc-primary: #16b3eb;
  --dc-primary-soft: rgba(22, 179, 235, .14);
  --dc-danger: var(--dsw-alias-state-error-primary, #fb7185);
  /* 正文字体：风格化无衬线栈（与鉴权页一致），悬浮球/卡片各板块统一使用。 */
  --dc-font-sans: "Inter", "SF Pro Display", "SF Pro Text", -apple-system, "Segoe UI", "HarmonyOS Sans SC", "MiSans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  /* 等宽字体：风格化代码字体（与鉴权页一致），用于 TOTP 数字与密钥。 */
  --dc-font-mono: "JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", "Roboto Mono", ui-monospace, Menlo, Consolas, monospace;
  --dc-radius: 14px;
  --dc-radius-sm: 9px;
  --dc-gap: 12px;
}
#${HOST_ZONE_ID}, #${HOST_ZONE_ID} * { box-sizing: border-box; }
#${FAB_ID} {
  position: fixed; bottom: 16px; right: 16px;
  width: 44px; height: 44px; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  border-radius: 14px; cursor: pointer;
  background: var(--dc-bg);
  border: 1px solid var(--dc-border-strong);
  box-shadow: 0 10px 30px rgba(2, 8, 24, .55);
  overflow: hidden;
  transition: border-color .18s ease, transform .18s ease;
}
#${FAB_ID}:hover { border-color: var(--dc-primary); transform: translateY(-1px); }
#${SHEET_ID} {
  position: fixed; bottom: 16px; right: 16px; width: 356px; z-index: 2147482999;
  background: var(--dc-bg);
  border: 1px solid var(--dc-border);
  border-radius: 18px;
  box-shadow: 0 24px 64px rgba(2, 8, 24, .7);
  transform-origin: 100% 100%;
  display: flex; flex-direction: column;
  color: var(--dc-fg);
  /* 字体统一使用风格化无衬线栈（--dc-font-sans），各板块保持一致。 */
  font-family: var(--dc-font-sans);
  overflow: hidden;
  opacity: 0; pointer-events: none; visibility: hidden;
  backdrop-filter: blur(18px) saturate(1.2);
}
#${TRIGGER_ID} {
  position: fixed; bottom: 0; right: 0; width: 96px; height: 96px; z-index: 2147482998;
  pointer-events: auto;
}
.dcb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--dc-border); }
.dcb-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dcb-brand-title { font-size: 15px; font-weight: 700; color: var(--dc-fg); line-height: 1.15; letter-spacing: -.01em; }
.dcb-brand-sub { font-size: 11px; color: var(--dc-fg-dim); }
.dcb-head-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
/* 登录按钮：user icon 头像（未登录）；登录后整体由 profile 头像替换。 */
.dcb-head-login { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--dc-border-strong); background: var(--dc-bg-soft); color: var(--dc-fg-soft); cursor: pointer; transition: all .15s ease; }
.dcb-head-login:hover { color: var(--dc-primary); border-color: var(--dc-primary); background: var(--dc-primary-soft); }
.dcb-head-user { display: flex; align-items: center; gap: 7px; position: relative; cursor: pointer; padding: 3px 9px 3px 3px; border-radius: 999px; border: 1px solid transparent; transition: border-color .15s ease, background .15s ease; }
.dcb-head-user:hover { border-color: var(--dc-border); background: var(--dc-card-hover); }
.dcb-head-user .dcb-user-name { max-width: 108px; }
.dcb-head-user .dcb-user-avatar { width: 28px; height: 28px; }
.dcb-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: var(--dc-gap); max-height: 74vh; overflow-y: auto; }
.dcb-body::-webkit-scrollbar { width: 6px; }
.dcb-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(148,163,184,.2)); border-radius: 8px; }

/* ····· 核心卡：2FA 验证码 ····· */
.dcb-card { border: 1px solid var(--dc-border); border-radius: var(--dc-radius); background: var(--dc-card); padding: 14px; }
.dcb-otp { display: flex; flex-direction: column; gap: 12px; }
.dcb-otp-head { display: flex; align-items: baseline; justify-content: space-between; }
.dcb-otp-label { font-size: 12px; font-weight: 600; letter-spacing: .04em; color: var(--dc-fg-dim); text-transform: uppercase; }
.dcb-otp-label-row { display: inline-flex; align-items: center; gap: 7px; }
.dcb-otp-qr-trigger { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin-left: 4px; border-radius: 7px; border: 1px solid var(--dc-border-strong); background: var(--dc-bg-soft); color: var(--dc-fg-soft); cursor: pointer; transition: all .15s ease; vertical-align: middle; }
.dcb-otp-qr-trigger:hover { color: var(--dc-primary); border-color: var(--dc-primary); background: var(--dc-primary-soft); }
.dcb-totp-remain { font-size: 12px; color: var(--dc-fg-dim); font-variant-numeric: tabular-nums; }
.dcb-otp-code { display: flex; align-items: center; justify-content: center; gap: 7px; }
.dcb-otp-digit { width: 40px; height: 48px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 10px; border: 1px solid var(--dc-border); background: var(--dc-bg-soft); font-family: var(--dc-font-mono); font-size: 28px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; color: var(--dc-fg); }
.dcb-otp-digit:nth-child(4) { margin-left: 7px; }
.dcb-otp-count { height: 4px; border-radius: 999px; background: rgba(148,163,184,.14); overflow: hidden; }
.dcb-totp-bar { display: block; height: 100%; background: var(--dc-primary); border-radius: 999px; width: 100%; transition: width 1s linear; }
.dcb-qr-wrap { display: flex; flex-direction: column; gap: 10px; animation: dcbFadeIn .2s ease; }
/* 二维码 + 密钥叠层卡片：默认重叠 90% 居中，hover 展开左右平铺 */
.dcb-qr-deck { position: relative; height: 150px; }
.dcb-qr-card { position: absolute; top: 4px; width: 142px; height: 142px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--dc-border); border-radius: var(--dc-radius-sm); background: var(--dc-bg-soft); box-shadow: 0 4px 16px rgba(2,8,24,.14); transition: left .32s cubic-bezier(.22,1,.36,1), transform .32s cubic-bezier(.22,1,.36,1); }
.dcb-qr-card--front { left: calc(50% - 78px); z-index: 2; }
.dcb-qr-card--back { left: calc(50% - 64px); z-index: 1; }
.dcb-qr-deck:hover .dcb-qr-card--front { left: 0; }
.dcb-qr-deck:hover .dcb-qr-card--back { left: calc(100% - 142px); }
.dcb-qr { display: block; width: 118px; height: 118px; image-rendering: pixelated; border-radius: 8px; background: #fff; padding: 5px; }
.dcb-qr-secret { display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 8px 6px; width: 100%; height: 100%; padding: 10px; box-sizing: border-box; }
.dcb-secret-group { flex: 0 0 calc(50% - 3px); font-family: var(--dc-font-mono); font-size: 13px; color: var(--dc-fg); text-align: center; letter-spacing: .04em; line-height: 1.4; font-variant-numeric: tabular-nums; }
.dcb-qr-actions { display: flex; gap: 8px; }
.dcb-qr-actions .dcb-iconbtn { flex: 1; padding: 7px 9px; text-align: center; }
.dcb-iconbtn { flex-shrink: 0; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--dc-border); background: transparent; color: var(--dc-fg-dim); cursor: pointer; font-size: 11px; transition: all .15s ease; }
.dcb-iconbtn:hover { color: var(--dc-primary); border-color: var(--dc-primary); }
.dcb-iconbtn.danger:hover { color: var(--dc-danger); border-color: rgba(251,113,133,.4); }

/* ····· 配置分组行 ····· */
.dcb-group { display: flex; flex-direction: column; border: 1px solid var(--dc-border); border-radius: var(--dc-radius); background: var(--dc-card); overflow: hidden; }
.dcb-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; }
.dcb-row + .dcb-row { border-top: 1px solid var(--dc-border); }
.dcb-row-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1; }
.dcb-row-label { font-size: 13px; font-weight: 600; color: var(--dc-fg); }
.dcb-row-sub { font-size: 11px; color: var(--dc-fg-dim); line-height: 1.4; display: flex; align-items: center; }
.dcb-row-sub > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcb-sub-copy { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 6px; padding: 0; border: none; background: transparent; color: var(--dc-fg-dim); cursor: pointer; transition: color .15s ease; flex-shrink: 0; }
.dcb-sub-copy:hover { color: var(--dc-primary); }
.dcb-sub-copy.copied { color: var(--dsw-alias-state-success-primary, #34d399); }
.dcb-user { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 4px; }
.dcb-user-avatar { width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; background: var(--dc-bg-soft); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: var(--dc-primary); overflow: hidden; border: 1px solid var(--dc-border-strong); }
.dcb-user-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dcb-user-name { font-size: 12px; color: var(--dc-fg); font-weight: 500; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcb-row-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* 开关（shadcn Switch 语义） */
.dcb-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
.dcb-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.dcb-switch .dcb-track { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-label-caption, rgba(100,116,139,.4)); transition: background .18s ease; pointer-events: none; }
.dcb-switch .dcb-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s ease, box-shadow .18s ease; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.dcb-switch input:checked + .dcb-track { background: var(--dc-primary); }
.dcb-switch input:checked + .dcb-track::after { transform: translateX(18px); }
.dcb-switch input:disabled { cursor: not-allowed; }
.dcb-switch input:disabled + .dcb-track { opacity: .45; }

/* ····· 主操作按钮 ····· */
.dcb-primary { width: 100%; padding: 11px; border-radius: var(--dc-radius-sm); border: none; cursor: pointer; font-size: 13px; font-weight: 600; letter-spacing: .01em; background: var(--dc-primary); color: #02080f; transition: all .15s ease; }
.dcb-primary:hover { filter: brightness(1.08); }
.dcb-primary.danger { background: var(--dc-danger); color: #fff; }
.dcb-primary:disabled { opacity: .5; cursor: not-allowed; }
.dcb-btn-row { display: flex; gap: 8px; }
.dcb-btn-row .dcb-primary { flex: 1; }

/* 开发模式行 */
.dcb-dev { border: 1px solid var(--dc-border); border-radius: var(--dc-radius); background: var(--dc-card); }

/* 远端单行（时长 + 断开） */
.dcb-remote-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 2px; }
.dcb-remote-duration { font-size: 15px; font-weight: 700; color: var(--dc-fg); font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.dcb-remote-status { font-size: 11px; color: var(--dc-fg-dim); margin-top: 2px; }

@keyframes dcbFadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

/* ····· 二维码整卡切换面板 ····· */
.dcb-qr-panel { display: flex; flex-direction: column; gap: 12px; animation: dcbFadeIn .2s ease; }
.dcb-qr-close { margin-left: auto; padding: 2px 10px; border: 1px solid var(--dc-border); background: transparent; color: var(--dc-fg-dim); border-radius: 7px; cursor: pointer; font-size: 14px; line-height: 1; transition: all .15s ease; }
.dcb-qr-close:hover { color: var(--dc-danger); border-color: rgba(251,113,133,.4); }
`

type HostState = 'idle' | 'ready'

interface HostUi {
  state: HostState
  dispose: () => void
}

/** 生成 TOTP otpauth URI 的二维码（data URL；用公开二维码服务，离线时降级为手动输入）。 */
function qrDataUrl(otpauthUri: string): string {
  const encoded = encodeURIComponent(otpauthUri)
  return `https://api.qrserver.com/v1/create-qr-code/?size=132x132&data=${encoded}`
}

/** 隧道 URL 的二级域名前缀（去 https:// 协议与路径）。 */
function prettyHost(url: string | null): string {
  if (!url) return ''
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

/** 隧道 URL 的最前段（标识字段），如 surround-magnetic-belly-intelligent。 */
function prettySubdomain(url: string | null): string {
  if (!url) return ''
  return prettyHost(url).split('.')[0] || ''
}

/** 文字复制（剪贴板 + 按钮「已复制」短暂反馈）。 */
function copyText(text: string, btn: HTMLElement): void {
  void navigator.clipboard?.writeText(text)
  btn.textContent = '已复制'
  setTimeout(() => (btn.textContent = '复制'), 1200)
}

/** 复制完整 URL（icon 按钮：复制 → 对勾短暂反馈）。 */
function copyIconText(text: string, btn: HTMLElement): void {
  if (!text) return
  void navigator.clipboard?.writeText(text)
  btn.innerHTML = CHECK_ICON
  btn.classList.add('copied')
  setTimeout(() => {
    btn.innerHTML = COPY_ICON
    btn.classList.remove('copied')
  }, 1200)
}

/** TOTP secret 分组渲染（每 4 字符一组，flex 换行，每行 2 组）。 */
function renderSecretGroups(secret: string): string {
  const groups = secret.replace(/\s/g, '').match(/.{1,4}/g) ?? []
  return groups.map((g) => `<span class="dcb-secret-group">${g}</span>`).join('')
}

/** 判断是否已注入（幂等守卫）。 */
export function hostUiInjected(): boolean {
  return document.getElementById(HOST_ZONE_ID) !== null
}

/** 域守卫：远端快照/非本地 dsh 上下文不注入（防双角色死循环）。 */
function isRemoteContext(): boolean {
  const { hostname, port } = window.location
  return hostname === 'sonar-landing-page.deepc.cn' || port === '8789'
}

/** 是否 loopback 访问（本地 dsh：显示完整配置卡片；远端：仅显示时长+断开单行）。 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** 连接时长格式化（MM:SS，超 1 小时 HH:MM:SS）。 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 注入悬浮球 + Sheet 卡片，返回控制句柄。 */
export function bootstrapHostUi(): HostUi {
  if (hostUiInjected() || isRemoteContext()) {
    return { state: 'idle', dispose: () => {} }
  }

  // 注入独立命名空间 CSS
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // 悬浮球（右下角，deepSea 品牌图标）
  const fab = document.createElement('div')
  fab.id = FAB_ID
  fab.innerHTML = DEEPSEA_LOGO
  fab.title = 'deepSea 互联'

  // Sheet 卡片（从图标位置向上生长）
  const sheet = document.createElement('div')
  sheet.id = SHEET_ID
  sheet.innerHTML = `
    <div class="dcb-head">
      <div class="dcb-brand">
        ${DEEPSEA_LOGO}
        <div>
          <div class="dcb-brand-title">deepSea</div>
          <div class="dcb-brand-sub">远端互联</div>
        </div>
      </div>
      <div class="dcb-head-right">
        <button class="dcb-head-login" id="dcb-head-login" title="登录主站">${USER_ICON}</button>
        <div class="dcb-head-user" id="dcb-head-user" style="display:none" title="点击登出">
          <span class="dcb-user-avatar" id="dcb-head-avatar"></span>
          <span class="dcb-user-name" id="dcb-head-name"></span>
        </div>
      </div>
    </div>
    <div class="dcb-body">

      <div class="dcb-remote-row" id="dcb-remote-row" style="display:none">
        <div class="dcb-row-main">
          <div class="dcb-remote-duration" id="dcb-remote-duration">已连接</div>
          <div class="dcb-remote-status">远程控制 · 本机配置不可见</div>
        </div>
        <button class="dcb-iconbtn danger" id="dcb-remote-disconnect">断开</button>
      </div>

      <div class="dcb-card dcb-otp" id="dcb-otp-panel">
        <div class="dcb-otp-head">
          <span class="dcb-otp-label dcb-otp-label-row">
            2FA 安全码
            <button class="dcb-otp-qr-trigger" id="dcb-qr-toggle" title="显示二维码绑定">${QR_ICON}</button>
          </span>
          <span class="dcb-totp-remain" id="dcb-totp-remain"></span>
        </div>
        <div class="dcb-otp-code" id="dcb-totp-code">------</div>
        <div class="dcb-otp-count"><span class="dcb-totp-bar" id="dcb-totp-bar"></span></div>
      </div>

      <div class="dcb-card dcb-qr-panel" id="dcb-qr-panel" style="display:none">
        <div class="dcb-otp-head">
          <span class="dcb-otp-label">绑定 2FA</span>
          <button class="dcb-qr-close" id="dcb-qr-close">×</button>
        </div>
        <div class="dcb-qr-deck">
          <div class="dcb-qr-card dcb-qr-card--front">
            <img class="dcb-qr" id="dcb-qr" alt="2FA 二维码" />
          </div>
          <div class="dcb-qr-card dcb-qr-card--back">
            <code class="dcb-qr-secret" id="dcb-totp-secret"></code>
          </div>
        </div>
        <div class="dcb-qr-actions">
          <button class="dcb-iconbtn" id="dcb-totp-copy">复制</button>
          <button class="dcb-iconbtn danger" id="dcb-totp-rotate">重置</button>
        </div>
      </div>

      <div class="dcb-group">
        <div class="dcb-row">
          <div class="dcb-row-main">
            <div class="dcb-row-label">本地共享</div>
            <div class="dcb-row-sub">
              <span id="dcb-local-sub">局域网可访问本机 3081 端口</span>
              <button class="dcb-sub-copy" id="dcb-local-url-copy" title="复制完整地址" style="display:none">${COPY_ICON}</button>
            </div>
          </div>
          <label class="dcb-switch">
            <input type="checkbox" id="dcb-local-switch" />
            <span class="dcb-track"></span>
          </label>
        </div>
        <div class="dcb-row">
          <div class="dcb-row-main">
            <div class="dcb-row-label">隧道映射</div>
            <div class="dcb-row-sub">
              <span id="dcb-tunnel-sub">通过 Cloudflare 暴露到公网</span>
              <button class="dcb-sub-copy" id="dcb-tunnel-url-copy" title="复制完整地址" style="display:none">${COPY_ICON}</button>
            </div>
          </div>
          <label class="dcb-switch">
            <input type="checkbox" id="dcb-tunnel-switch" />
            <span class="dcb-track"></span>
          </label>
        </div>
        <div class="dcb-row">
          <div class="dcb-row-main">
            <div class="dcb-row-label">主站免密</div>
            <div class="dcb-row-sub">从 deepc 后台打开节点时免输 2FA</div>
          </div>
          <label class="dcb-switch">
            <input type="checkbox" id="dcb-bypass" />
            <span class="dcb-track"></span>
          </label>
        </div>
        <div class="dcb-row">
          <div class="dcb-row-main">
            <div class="dcb-row-label">开发模式</div>
            <div class="dcb-row-sub">使用本地 127.0.0.1:5174 基址</div>
          </div>
          <label class="dcb-switch">
            <input type="checkbox" id="dcb-devmode" />
            <span class="dcb-track"></span>
          </label>
        </div>
      </div>
    </div>
  `

  // 右下角触发热区（鼠标靠近时唤出图标）
  const trigger = document.createElement('div')
  trigger.id = TRIGGER_ID

  document.body.appendChild(fab)
  document.body.appendChild(sheet)
  document.body.appendChild(trigger)

  // 交互状态
  let state: HostState = 'idle'
  let isOpen = false
  let isHovering = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  const headLogin = sheet.querySelector<HTMLElement>('#dcb-head-login')!
  const headUser = sheet.querySelector<HTMLElement>('#dcb-head-user')!
  const headAvatar = sheet.querySelector<HTMLElement>('#dcb-head-avatar')!
  const headName = sheet.querySelector<HTMLElement>('#dcb-head-name')!
  const devModeInput = sheet.querySelector<HTMLInputElement>('#dcb-devmode')!
  const bypassInput = sheet.querySelector<HTMLInputElement>('#dcb-bypass')!
  const totpCodeEl = sheet.querySelector<HTMLElement>('#dcb-totp-code')!
  const totpBar = sheet.querySelector<HTMLElement>('#dcb-totp-bar')!
  const totpRemain = sheet.querySelector<HTMLElement>('#dcb-totp-remain')!
  const otpPanel = sheet.querySelector<HTMLElement>('#dcb-otp-panel')!
  const qrToggle = sheet.querySelector<HTMLElement>('#dcb-qr-toggle')!
  const qrPanel = sheet.querySelector<HTMLElement>('#dcb-qr-panel')!
  const qrClose = sheet.querySelector<HTMLElement>('#dcb-qr-close')!
  const qrImg = sheet.querySelector<HTMLImageElement>('#dcb-qr')!
  const totpSecretEl = sheet.querySelector<HTMLElement>('#dcb-totp-secret')!
  const totpCopy = sheet.querySelector<HTMLElement>('#dcb-totp-copy')!
  const totpRotate = sheet.querySelector<HTMLElement>('#dcb-totp-rotate')!
  const localSwitch = sheet.querySelector<HTMLInputElement>('#dcb-local-switch')!
  const localSub = sheet.querySelector<HTMLElement>('#dcb-local-sub')!
  const localUrlCopy = sheet.querySelector<HTMLElement>('#dcb-local-url-copy')!
  const tunnelSwitch = sheet.querySelector<HTMLInputElement>('#dcb-tunnel-switch')!
  const tunnelSub = sheet.querySelector<HTMLElement>('#dcb-tunnel-sub')!
  const tunnelUrlCopy = sheet.querySelector<HTMLElement>('#dcb-tunnel-url-copy')!
  const remoteRow = sheet.querySelector<HTMLElement>('#dcb-remote-row')!
  const remoteDuration = sheet.querySelector<HTMLElement>('#dcb-remote-duration')!
  const remoteDisconnect = sheet.querySelector<HTMLElement>('#dcb-remote-disconnect')!

  // 是否远端访问（非 loopback）：远端只显示「时长 + 断开」单行，隐藏本机配置卡片。
  const remoteMode = !isLoopbackHost(window.location.hostname)
  if (remoteMode) {
    otpPanel.style.display = 'none'
    qrPanel.style.display = 'none'
    const group = sheet.querySelector<HTMLElement>('.dcb-group')
    if (group) group.style.display = 'none'
    remoteRow.style.display = ''
    // 每秒刷新连接时长
    setInterval(() => {
      if (status.connectedAt) {
        remoteDuration.textContent = formatDuration(Date.now() - status.connectedAt)
      }
    }, 1000)
    // 断开按钮：断开隧道（远端访问随之失效；隧道断开后页面即失效，无需再刷新）
    remoteDisconnect.addEventListener('click', () => {
      void deepcCall('disconnect')
    })
  }

  // 前端展示态（从后端 status 同步）。
  let status: BackendStatus = {
    mode: 'local',
    loggedIn: false,
    deviceName: '',
    connected: false,
    url: null,
    localUrl: null,
    localOn: true,
    totpSecret: null,
    otpauthUri: null,
  }

  /** 前端调试日志（开发模式下输出到浏览器控制台）。 */
  function debugLog(msg: string): void {
    if (status.devMode) console.log(`[deepc:ui] ${msg}`)
  }

  function renderHead(): void {
    if (status.loggedIn && status.profile) {
      const p = status.profile
      const name = p.name?.trim() || p.login
      headLogin.style.display = 'none'
      headUser.style.display = 'flex'
      headName.textContent = name
      headName.title = `@${p.login}`
      headAvatar.innerHTML = ''
      if (p.avatar_url) {
        const img = document.createElement('img')
        img.src = p.avatar_url
        img.alt = name
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('error', () => {
          headAvatar.textContent = p.login.slice(0, 2).toUpperCase()
        })
        headAvatar.appendChild(img)
      } else {
        headAvatar.textContent = p.login.slice(0, 2).toUpperCase()
      }
    } else {
      headLogin.style.display = ''
      headUser.style.display = 'none'
    }
  }

  function renderTiers(): void {
    // 本地共享开关（默认开）。
    localSwitch.checked = status.localOn !== false
    // 本地共享开启后：直接显示局域网访问地址 + 复制按钮；未取到本机 IP 时回退占位描述。
    if (status.localOn !== false) {
      if (status.localUrl) {
        localSub.textContent = status.localUrl
        localSub.title = status.localUrl
        localUrlCopy.style.display = ''
      } else {
        localSub.textContent = '局域网可访问本机 3081 端口'
        localSub.title = ''
        localUrlCopy.style.display = 'none'
      }
    } else {
      localSub.textContent = '已关闭，仅本机可访问'
      localSub.title = ''
      localUrlCopy.style.display = 'none'
    }
    // 隧道映射：mode 非 local 即隧道开（tunnel/managed）。始终可开可关（不因登录锁定）。
    const tunnelActive = status.mode !== 'local'
    tunnelSwitch.checked = tunnelActive
    tunnelSwitch.disabled = false
    // 隧道状态机文案：待下载 → 下载中 → 已下载 → 启动中 → 已启动/已纳管（+ 二级域名）。
    const st = status.tunnelState ?? 'off'
    if (st === 'off') {
      tunnelSub.textContent = '通过 Cloudflare 暴露到公网'
      tunnelSub.title = ''
      tunnelUrlCopy.style.display = 'none'
    } else if (st === 'download-pending') {
      tunnelSub.textContent = 'cloudflared 待下载'
      tunnelSub.title = ''
      tunnelUrlCopy.style.display = 'none'
    } else if (st === 'downloading') {
      tunnelSub.textContent = 'cloudflared 下载中…'
      tunnelSub.title = ''
      tunnelUrlCopy.style.display = 'none'
    } else if (st === 'downloaded') {
      tunnelSub.textContent = 'cloudflared 已下载'
      tunnelSub.title = ''
      tunnelUrlCopy.style.display = 'none'
    } else if (st === 'starting') {
      tunnelSub.textContent = '隧道连接中…'
      tunnelSub.title = ''
      tunnelUrlCopy.style.display = 'none'
    } else if (st === 'running' || st === 'managed') {
      // 已启动 / 已纳管：状态词后方显示二级域名 + 复制按钮（复制完整 URL）。
      const label = st === 'managed' ? '已纳管' : '已启动'
      if (status.url) {
        tunnelSub.textContent = `${label} · ${prettySubdomain(status.url)}`
        tunnelSub.title = status.url
        tunnelUrlCopy.style.display = ''
      } else {
        tunnelSub.textContent = label
        tunnelSub.title = ''
        tunnelUrlCopy.style.display = 'none'
      }
    } else {
      tunnelSub.textContent = '隧道连接中…'
      tunnelSub.title = ''
      tunnelUrlCopy.style.display = 'none'
    }
  }

  function renderTotp(): void {
    if (status.otpauthUri) {
      qrImg.src = qrDataUrl(status.otpauthUri)
      totpSecretEl.innerHTML = renderSecretGroups(status.totpSecret ?? '')
    } else {
      qrImg.removeAttribute('src')
      totpSecretEl.innerHTML = ''
    }
    void tickTotp()
  }

  /** 将 6 位 TOTP 码渲染为等宽数字格子（3+3 分组，中间留白）。 */
  function renderOtp(value: string): void {
    const chars = value.replace(/\s/g, '').split('')
    totpCodeEl.innerHTML = chars
      .map((c) => `<span class="dcb-otp-digit">${c}</span>`)
      .join('')
  }
  renderOtp('------')

  /** 刷新 6 位 TOTP 动态码 + 30s 倒计时（本地即 2FA 客户端）。 */
  async function tickTotp(): Promise<void> {
    if (!status.totpSecret) {
      renderOtp('------')
      totpRemain.textContent = ''
      totpBar.style.width = '0%'
      return
    }
    const now = Date.now()
    const stepMs = 30_000
    const remainingMs = stepMs - (now % stepMs)
    const remainSec = Math.ceil(remainingMs / 1000)
    const code = await browserTotpCode(status.totpSecret, now)
    renderOtp(code)
    totpRemain.textContent = `${remainSec}s`
    // 剩余 ≤ 5s 时倒计时/进度条转红，提示动态码即将轮换（参考主流 TOTP 应用）。
    const expiring = remainSec <= 5
    totpRemain.style.color = expiring ? 'var(--dc-danger)' : ''
    totpBar.style.width = `${(remainingMs / stepMs) * 100}%`
    totpBar.style.background = expiring ? 'var(--dc-danger)' : ''
  }

  /** 根据后端状态快照刷新 UI。 */
  /** 远端单行：刷新连接时长。 */
  function renderRemote(): void {
    if (status.connectedAt) {
      remoteDuration.textContent = formatDuration(Date.now() - status.connectedAt)
    } else {
      remoteDuration.textContent = status.connected ? '已连接' : '未连接'
    }
  }

  function applyStatus(next: BackendStatus): void {
    status = next
    if (remoteMode) {
      renderRemote()
    } else {
      renderHead()
      renderTiers()
      renderTotp()
    }
    if (typeof next.devMode === 'boolean' && devModeInput.checked !== next.devMode) {
      devModeInput.checked = next.devMode
    }
    if (typeof next.allowBypass === 'boolean' && bypassInput.checked !== next.allowBypass) {
      bypassInput.checked = next.allowBypass
    }
  }

  /** 拉取后端状态并刷新 UI（远端访问时带 X-Deepc-Remote 头，后端裁剪敏感字段）。 */
  async function refreshStatus(): Promise<void> {
    const s = await deepcCall<BackendStatus>('status', undefined, remoteMode)
    if (!s) return
    applyStatus(s)
    debugLog(
      `状态：mode=${s.mode}, connected=${s.connected}, url=${s.url ?? '-'}, localOn=${s.localOn}, loggedIn=${s.loggedIn}`,
    )
  }

  // ── 本地共享开关 ──
  localSwitch.addEventListener('change', () => {
    void (async () => {
      debugLog(`本地共享 → ${localSwitch.checked}`)
      const r = await deepcCall<{ ok?: boolean }>('local', { on: localSwitch.checked })
      if (r && !r.ok) {
        localSwitch.checked = !localSwitch.checked
      }
      await refreshStatus()
    })()
  })

  // ── 隧道映射开关 ──
  tunnelSwitch.addEventListener('change', () => {
    const on = tunnelSwitch.checked
    void (async () => {
      // 开：已登录 → managed（上报）；未登录 → tunnel。关：local（仅 3081 局域网）。
      const target: BackendStatus['mode'] = on ? (status.loggedIn ? 'managed' : 'tunnel') : 'local'
      debugLog(`隧道映射 → ${on ? '开' : '关'}（mode=${target}）`)
      await deepcCall('mode', { mode: target })
      await refreshStatus()
    })()
  })

  // ── 登录 / 登出（头部）──
  headLogin.addEventListener('click', () => {
    void (async () => {
      debugLog('登录（Device Grant）')
      const r = await deepcCall<{ url?: string }>('login')
      if (r?.url) window.open(r.url, '_blank')
      await refreshStatus()
    })()
  })
  headUser.addEventListener('click', () => {
    // 点头像登出（二次确认）
    const name = status.profile?.name?.trim() || status.profile?.login || '当前账号'
    if (window.confirm(`登出 ${name} 并断开互联？`)) {
      void (async () => {
        debugLog('登出')
        await deepcCall('logout')
        await refreshStatus()
      })()
    }
  })

  // ── 二维码整卡切换（安全码卡片 ↔ 绑定二维码卡片）──
  function showQr(show: boolean): void {
    otpPanel.style.display = show ? 'none' : ''
    qrPanel.style.display = show ? '' : 'none'
  }
  qrToggle.addEventListener('click', () => {
    showQr(true)
  })
  qrClose.addEventListener('click', () => {
    showQr(false)
  })

  // ── 复制 ──
  totpCopy.addEventListener('click', () => {
    copyText(status.totpSecret ?? '', totpCopy)
  })
  localUrlCopy.addEventListener('click', () => {
    copyIconText(status.localUrl ?? '', localUrlCopy)
  })
  tunnelUrlCopy.addEventListener('click', () => {
    copyIconText(status.url ?? '', tunnelUrlCopy)
  })

  // ── 重新生成安全码 ──
  totpRotate.addEventListener('click', () => {
    void deepcCall('totp-rotate').then(() => refreshStatus())
  })

  // ── 开发模式开关 ──
  devModeInput.addEventListener('change', () => {
    debugLog(`开发模式 → ${devModeInput.checked}`)
    void deepcCall('devmode', { enabled: devModeInput.checked }).then(() => refreshStatus())
  })

  // ── 主站免密开关 ──
  bypassInput.addEventListener('change', () => {
    debugLog(`主站免密 → ${bypassInput.checked}`)
    void deepcCall('bypass', { enabled: bypassInput.checked }).then(() => refreshStatus())
  })

  // ── 展开/收起动画（animejs）─────────────────────
  function openSheet(): void {
    if (isOpen) return
    isOpen = true
    cancelHide()
    animate(fab, { scale: 0.3, opacity: 0, duration: 120, ease: 'outQuad' })
    sheet.style.visibility = 'visible'
    sheet.style.pointerEvents = 'auto'
    animate(sheet, {
      scale: [0.4, 1],
      opacity: [0, 1],
      translateY: [16, 0],
      duration: 240,
      ease: 'outBack(1.7)',
    })
  }

  function closeSheet(): void {
    if (!isOpen) return
    isOpen = false
    sheet.style.pointerEvents = 'none'
    animate(sheet, {
      scale: [1, 0.5],
      opacity: [1, 0],
      translateY: [0, 12],
      duration: 150,
      ease: 'inQuad',
      onComplete: () => {
        sheet.style.visibility = 'hidden'
      },
    })
    animate(fab, {
      scale: [0.3, 1],
      opacity: [0, 1],
      duration: 150,
      ease: 'outBack(1.6)',
    })
    scheduleHide()
  }

  function cancelHide(): void {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function scheduleHide(): void {
    cancelHide()
    hideTimer = setTimeout(() => {
      if (!isOpen && !isHovering) hideFab()
    }, 1000)
  }

  function hideFab(): void {
    animate(fab, { translateX: 64, opacity: 0.35, duration: 240, ease: 'outQuad' })
  }

  function showFab(): void {
    if (isOpen) return
    cancelHide()
    animate(fab, { translateX: 0, opacity: 1, duration: 200, ease: 'outBack(1.7)' })
  }

  fab.addEventListener('click', (e) => {
    e.stopPropagation()
    if (isOpen) closeSheet()
    else {
      void refreshStatus()
      openSheet()
    }
  })

  sheet.addEventListener('click', (e) => e.stopPropagation())

  document.addEventListener('click', () => {
    if (isOpen) closeSheet()
  })

  fab.addEventListener('mouseenter', () => {
    isHovering = true
    cancelHide()
  })
  fab.addEventListener('mouseleave', () => {
    isHovering = false
    if (!isOpen) scheduleHide()
  })
  trigger.addEventListener('mouseenter', () => {
    isHovering = true
    showFab()
  })
  trigger.addEventListener('mouseleave', () => {
    isHovering = false
    if (!isOpen) scheduleHide()
  })

  scheduleHide()

  // 仅本地（127.0.0.1:3080 同源）轮询：远端访问（隧道域名）只在打开 sheet 时拉一次
  // 裁剪后的状态，避免持续向隧道域名发 /deepc/status（每 3s 经 CF 隧道的浪费请求 +
  // TOTP secret 等敏感字段持续下发到远端浏览器内存的风险）。
  void refreshStatus()
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let totpTimer: ReturnType<typeof setInterval> | null = null
  if (!remoteMode) {
    pollTimer = setInterval(() => {
      void refreshStatus()
    }, 3000)
    totpTimer = setInterval(() => {
      void tickTotp()
    }, 1000)
  }

  return {
    get state() {
      return state
    },
    dispose(): void {
      if (hideTimer) clearTimeout(hideTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (totpTimer) clearInterval(totpTimer)
      fab.remove()
      sheet.remove()
      trigger.remove()
      style.remove()
    },
  }
}
