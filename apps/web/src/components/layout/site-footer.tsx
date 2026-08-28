// ---------------------------------------------------------------------------
// SiteFooter —— 全站统一底部（首页 showcase 与所有子页面共用）。
//
// ⚠️ 单一源：主页（/）与子页面（/plugins /links /community 等）共用本组件，
//   ★ 不得再单独定义 footer（统一视觉行为与样式）。
//
// 视觉：中性半透明毛玻璃 + 深色 token，兼容深海主页（3D 海洋）与
// 子页面（暗色背景）。移动端垂直堆叠，桌面横排。
// ---------------------------------------------------------------------------

import { Copyright } from "lucide-react"

const YEAR = new Date().getFullYear()

export function SiteFooter() {
  return (
    <footer className="shrink-0 border-t border-white/10 bg-slate-950/60 py-4 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 text-sm text-white/70 sm:flex-row sm:px-6">
        {/* 左侧：品牌 + GitHub stars（均指向仓库） */}
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/evil7/deepSea"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold tracking-tight text-white transition-colors hover:text-sky-200"
          >
            deepSea
          </a>
          <span className="text-white/40">·</span>
          <a
            href="https://github.com/evil7/deepSea"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-opacity hover:opacity-80"
            aria-label="GitHub stars"
          >
            <img
              alt="GitHub Repo stars"
              src="https://img.shields.io/github/stars/evil7/deepSea?style=social"
              className="inline-block h-4 w-auto"
            />
          </a>
        </div>

        {/* 右侧：版权 icon + 自动年份 · deePwn */}
        <div className="flex items-center gap-1.5 text-white/50">
          <Copyright className="size-3.5" />
          <span>{YEAR}</span>
          <span className="text-white/40">·</span>
          <a
            href="https://deepwn.com"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-sky-200"
          >
            deePwn
          </a>
        </div>
      </div>
    </footer>
  )
}
