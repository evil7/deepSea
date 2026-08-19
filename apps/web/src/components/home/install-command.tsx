import { useState } from "react"
import { Check, Copy } from "lucide-react"

import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// InstallCommand —— 首页 hero 的 deepc 安装命令提示（独立组件 + 自定义 CSS）
//   · 终端风格：提示符 + 等宽命令 + 光标闪烁，弱化存在感不破坏首页美感
//   · 点击命令条复制整条 `dsh plugin add deepc`（复制成功短暂显示 ✓）
//   · 样式：Tailwind 原子类 + custom.css 里的 .deepc-install 自定义层
//     （光标闪烁 / 玻璃底 / 外发光），避免污染其他组件
// ---------------------------------------------------------------------------

const COMMAND = "dsh plugin add deepc"

export function InstallCommand() {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND)
    } catch {
      // 剪贴板受限（非安全上下文/权限被拒）时降级：临时 textarea + execCommand
      const el = document.createElement("textarea")
      el.value = COMMAND
      el.setAttribute("readonly", "")
      el.style.position = "fixed"
      el.style.opacity = "0"
      document.body.appendChild(el)
      el.select()
      document.execCommand("copy")
      el.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`复制安装命令 ${COMMAND}`}
      title="点击复制安装命令"
      className="deepc-install group mx-auto mt-8 inline-flex max-w-full items-center gap-2.5 rounded-full border border-cyan-400/25 bg-slate-950/55 px-4 py-2 font-mono text-sm text-cyan-100/90 shadow-[0_0_24px_rgba(34,211,238,0.15)] backdrop-blur-md transition-all duration-300 hover:border-cyan-300/50 hover:shadow-[0_0_32px_rgba(34,211,238,0.3)]"
    >
      {/* <TerminalSquare className="deepc-install__icon size-4 shrink-0 text-cyan-300/80" /> */}
      <span className="deepc-install__prompt select-none text-cyan-400/70">$</span>
      <code className="deepc-install__command whitespace-nowrap tracking-tight">
        {COMMAND}
      </code>
      <span className="deepc-install__cursor" aria-hidden="true" />
      <span
        className={cn(
          "ml-1 flex size-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 transition-colors",
          copied ? "text-emerald-300" : "text-cyan-300/70 group-hover:text-cyan-200"
        )}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </span>
    </button>
  )
}
