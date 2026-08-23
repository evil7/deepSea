// ---------------------------------------------------------------------------
// SiteFooter —— 全站统一底部（首页 showcase 与所有子页面共用）。
//
// ⚠️ 单一源：主页（/）与子页面（/plugins /links /community 等）共用本组件，
//   ★ 不得再单独定义 footer（统一视觉行为与样式）。
//
// 视觉：中性半透明毛玻璃 + 深色 token，兼容深海主页（3D 海洋）与
// 子页面（暗色背景）。移动端垂直堆叠，桌面横排。
// ---------------------------------------------------------------------------

import { Link } from "react-router-dom"

export function SiteFooter() {
  return (
    <footer className="shrink-0 border-t border-white/10 bg-slate-950/60 py-4 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 text-sm text-white/70 sm:flex-row sm:px-6">
        {/* 品牌 + 定位 */}
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="font-semibold tracking-tight text-white transition-colors hover:text-sky-200"
          >
            deepSea
          </Link>
          <span className="text-white/40">·</span>
          <span>DeepSeek Harness 插件生态的入海口</span>
        </div>

        {/* 右侧：GitHub stars + 版权 */}
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/evil7/deepSea"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
          >
            <img
              alt="GitHub Repo stars"
              src="https://img.shields.io/github/stars/evil7/deepSea?style=social&label=Star"
              className="inline-block h-4 w-auto"
            />
          </a>
          <span className="text-white/50">© 2026 deepSea</span>
        </div>
      </div>
    </footer>
  )
}
