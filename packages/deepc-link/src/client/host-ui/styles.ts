/**
 * host-ui 样式（独立命名空间 + dsh 主题变量适配）。
 */

import { FAB_ID, HOST_ZONE_ID, SHEET_ID, TRIGGER_ID } from './constants'

/**
 * 现代简约设计 token（移植 shadcn 语义到 vanilla DOM，插件端不依赖 React/Tailwind）。
 * dsh 的 --dsw-alias-* 变量挂在 body 上（html 上为空），故中转变量也需定义在 body。
 */
export const HOST_UI_CSS = `
body {
  --dc-bg: var(--dsw-alias-bg-layer-2, rgba(12, 16, 28, .98));
  --dc-bg-soft: var(--dsw-alias-bg-layer-1, rgba(20, 26, 42, .75));
  --dc-card: var(--dsw-alias-bg-base, rgba(255, 255, 255, .025));
  --dc-card-hover: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .05));
  --dc-border: var(--dsw-alias-border-l2, rgba(148, 163, 184, .14));
  --dc-border-strong: var(--dsw-alias-border-l3, rgba(148, 163, 184, .26));
  --dc-fg: var(--dsw-alias-label-primary, #e6ebf2);
  --dc-fg-soft: var(--dsw-alias-label-secondary, #9aa6b8);
  --dc-fg-dim: var(--dsw-alias-label-tertiary, #6b7688);
  --dc-primary: #16b3eb;
  --dc-primary-soft: rgba(22, 179, 235, .14);
  --dc-danger: var(--dsw-alias-state-error-primary, #fb7185);
  --dc-font-sans: "Inter", "SF Pro Display", "SF Pro Text", -apple-system, "Segoe UI", "HarmonyOS Sans SC", "MiSans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
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
  font-family: var(--dc-font-sans);
  overflow: hidden;
  opacity: 0; pointer-events: none; visibility: hidden;
  backdrop-filter: blur(18px) saturate(1.2);
}
/* 远端单行：宽度自适应紧凑，高度对齐悬浮球 */
#${SHEET_ID}.dcb-remote-sheet { width: auto; min-width: 132px; border-radius: 14px; }
#${TRIGGER_ID} {
  position: fixed; bottom: 0; right: 0; width: 96px; height: 96px; z-index: 2147482998;
  pointer-events: auto;
}
.dcb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--dc-border); }
.dcb-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dcb-brand-title { font-size: 15px; font-weight: 700; color: var(--dc-fg); line-height: 1.15; letter-spacing: -.01em; }
.dcb-brand-sub { font-size: 11px; color: var(--dc-fg-dim); }
.dcb-head-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.dcb-head-login { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--dc-border-strong); background: var(--dc-bg-soft); color: var(--dc-fg-soft); cursor: pointer; transition: all .15s ease; }
.dcb-head-login:hover { color: var(--dc-primary); border-color: var(--dc-primary); background: var(--dc-primary-soft); }
.dcb-head-user { display: flex; align-items: center; gap: 7px; position: relative; cursor: pointer; padding: 3px 3px 3px 11px; border-radius: 999px; border: 1px solid transparent; transition: border-color .15s ease, background .15s ease; }
.dcb-head-user:hover { border-color: var(--dc-border); background: var(--dc-card-hover); }
.dcb-head-user .dcb-user-name { max-width: 108px; }
.dcb-head-user .dcb-user-avatar { width: 28px; height: 28px; }
.dcb-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: var(--dc-gap); max-height: 74vh; overflow-y: auto; }
.dcb-body.dcb-remote-body { padding: 0; overflow: visible; max-height: none; }
.dcb-body::-webkit-scrollbar { width: 6px; }
.dcb-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(148,163,184,.2)); border-radius: 8px; }

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
.dcb-qr-deck { position: relative; height: 164px; }
.dcb-qr-card { position: absolute; top: 4px; width: 154px; height: 154px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--dc-border); border-radius: var(--dc-radius-sm); background: var(--dc-bg-soft); box-shadow: 0 4px 16px rgba(2,8,24,.14); transition: left .32s cubic-bezier(.22,1,.36,1), transform .32s cubic-bezier(.22,1,.36,1); }
.dcb-qr-card--front { left: calc(50% - 84px); z-index: 2; }
.dcb-qr-card--back { left: calc(50% - 70px); z-index: 1; }
.dcb-qr-deck:hover .dcb-qr-card--front { left: 0; }
.dcb-qr-deck:hover .dcb-qr-card--back { left: calc(100% - 154px); }
.dcb-qr { display: block; width: 132px; height: 132px; image-rendering: pixelated; border-radius: 8px; background: #fff; padding: 6px; }
.dcb-qr-placeholder { display: flex; align-items: center; justify-content: center; width: 132px; height: 132px; border-radius: 8px; background: rgba(148,163,184,.08); color: var(--dc-fg-dim); font-size: 12px; line-height: 1.5; text-align: center; padding: 12px; box-sizing: border-box; }
.dcb-qr-secret { display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 8px 6px; width: 100%; height: 100%; padding: 10px; box-sizing: border-box; }
.dcb-secret-group { flex: 0 0 calc(50% - 3px); font-family: var(--dc-font-mono); font-size: 13px; color: var(--dc-fg); text-align: center; letter-spacing: .04em; line-height: 1.4; font-variant-numeric: tabular-nums; }
.dcb-qr-actions { display: flex; gap: 8px; }
.dcb-qr-actions .dcb-iconbtn { flex: 1; padding: 7px 9px; text-align: center; }
.dcb-iconbtn { flex-shrink: 0; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--dc-border); background: transparent; color: var(--dc-fg-dim); cursor: pointer; font-size: 11px; transition: all .15s ease; }
.dcb-iconbtn:hover { color: var(--dc-primary); border-color: var(--dc-primary); }
.dcb-iconbtn.danger:hover { color: var(--dc-danger); border-color: rgba(251,113,133,.4); }

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

.dcb-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
.dcb-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.dcb-switch .dcb-track { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-label-caption, rgba(100,116,139,.4)); transition: background .18s ease; pointer-events: none; }
.dcb-switch .dcb-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s ease, box-shadow .18s ease; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.dcb-switch input:checked + .dcb-track { background: var(--dc-primary); }
.dcb-switch input:checked + .dcb-track::after { transform: translateX(18px); }
.dcb-switch input:disabled { cursor: not-allowed; }
.dcb-switch input:disabled + .dcb-track { opacity: .45; }

.dcb-primary { width: 100%; padding: 11px; border-radius: var(--dc-radius-sm); border: none; cursor: pointer; font-size: 13px; font-weight: 600; letter-spacing: .01em; background: var(--dc-primary); color: #02080f; transition: all .15s ease; }
.dcb-primary:hover { filter: brightness(1.08); }
.dcb-primary.danger { background: var(--dc-danger); color: #fff; }
.dcb-primary:disabled { opacity: .5; cursor: not-allowed; }
.dcb-btn-row { display: flex; gap: 8px; }
.dcb-btn-row .dcb-primary { flex: 1; }

.dcb-dev { border: 1px solid var(--dc-border); border-radius: var(--dc-radius); background: var(--dc-card); }

.dcb-remote-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; height: 44px; padding: 0 6px 0 14px; }
.dcb-remote-duration { font-size: 13px; font-weight: 600; color: var(--dc-fg); font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.dcb-remote-status { font-size: 11px; color: var(--dc-fg-dim); margin-top: 2px; }
.dcb-remote-body .dcb-iconbtn { font-size: 12px; font-weight: 500; padding: 5px 11px; border-radius: 8px; }

@keyframes dcbFadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

.dcb-qr-panel { display: flex; flex-direction: column; gap: 12px; animation: dcbFadeIn .2s ease; }
.dcb-qr-back { display: inline-flex; align-items: center; gap: 5px; }
.dcb-qr-back .dcb-qr-back-icon { display: inline-flex; }
.dcb-qr-back .dcb-qr-back-icon svg { display: block; }
.dcb-iconbtn.copied { color: var(--dsw-alias-state-success-primary, #34d399); border-color: var(--dsw-alias-state-success-primary, #34d399); }
.dcb-qr-copy-check { display: inline-flex; }
.dcb-qr-copy-check svg { display: block; }
`
