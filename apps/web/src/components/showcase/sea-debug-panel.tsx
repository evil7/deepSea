import { useEffect, useState } from "react"
import {
  Check,
  Copy,
  Minimize2,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react"

import {
  DEFAULT_CONF,
  OCEAN_PARAM_GROUPS,
  type OceanConf,
  type OceanParamMeta,
} from "@/components/showcase/ocean-conf"

interface SeaDebugPanelProps {
  /** 当前生效配置（来自父组件 state） */
  conf: Partial<OceanConf>
  /** 参数变化回调（传入完整配置） */
  onChange: (conf: Partial<OceanConf>) => void
}

// ---------------------------------------------------------------------------
// 调试面板（右侧抽屉版，内部调试用）
//   · 仅当 URL hash 为 #sea-debug 时显现；无 hash 时完全不渲染
//   · 所有参数卡片从上到下竖列排放，可滚动；不虚化背景（无 backdrop-blur）
//   · 最小化（Minimize2）→ 收起为右下角浮动按钮（不清除 #sea-debug），
//     点击浮动按钮恢复面板；关闭（X）才真正清除 hash 隐藏整个调试器
//   · 复制按钮导出完整 JSON（可直接作为 <Ocean conf={...} /> 传入）
// ---------------------------------------------------------------------------
export function SeaDebugPanel({ conf, onChange }: SeaDebugPanelProps) {
  const [open, setOpen] = useState(() => window.location.hash === "#sea-debug")
  const [minimized, setMinimized] = useState(false)
  const [local, setLocal] = useState<OceanConf>({ ...DEFAULT_CONF, ...conf })
  const [copied, setCopied] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)

  // hash 监听：仅当 hash 为 #sea-debug 时显现（内部调试用）
  useEffect(() => {
    const onHash = () => {
      setOpen(window.location.hash === "#sea-debug")
      setMinimized(false)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  // 外部 conf 变化（重置/恢复等）时同步本地
  useEffect(() => {
    setLocal({ ...DEFAULT_CONF, ...conf })
  }, [conf])

  const setParam = (key: keyof OceanConf, value: number | string | boolean) => {
    const next = { ...local, [key]: value }
    setLocal(next)
    onChange(next)
  }

  const reset = () => {
    const next = { ...DEFAULT_CONF }
    setLocal(next)
    onChange(next)
  }

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(local, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  // 最小化：收起为右下角浮动按钮（保留 #sea-debug，可随时恢复）
  const minimize = () => setMinimized(true)

  // 真正关闭：清 hash（保留滚动位置），面板与浮动按钮一起消失
  const close = () => {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search
    )
    setOpen(false)
    setMinimized(false)
  }

  const renderParam = (meta: OceanParamMeta) => {
    const value = local[meta.key]
    const label = (
      <span className="truncate text-xs text-slate-300">{meta.label}</span>
    )
    if (meta.type === "boolean") {
      return (
        <label className="flex cursor-pointer items-center gap-2">
          {label}
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => setParam(meta.key, e.target.checked)}
            className="size-4 cursor-pointer accent-cyan-400"
            aria-label={meta.label}
          />
        </label>
      )
    }
    if (meta.type === "color") {
      return (
        <div className="flex items-center gap-2">
          {label}
          <input
            type="color"
            value={String(value)}
            onChange={(e) => setParam(meta.key, e.target.value)}
            className="h-6 w-10 cursor-pointer rounded border border-white/20 bg-transparent"
            aria-label={meta.label}
          />
          <span className="font-mono text-[10px] text-slate-400">
            {String(value)}
          </span>
        </div>
      )
    }
    if (meta.type === "input") {
      // 手动数字输入：min 下限（如海底深度最小 10、光束长度最小 0），不限上限
      return (
        <NumberInput
          key={meta.key}
          label={meta.label}
          min={meta.min ?? 0}
          step={meta.step ?? 0.1}
          value={Number(value)}
          onCommit={(v) => setParam(meta.key, v)}
        />
      )
    }
    return (
      <label className="flex items-center gap-2">
        {label}
        <input
          type="range"
          min={meta.min ?? 0}
          max={meta.max ?? 1}
          step={meta.step ?? 0.01}
          value={Number(value)}
          onChange={(e) => setParam(meta.key, Number(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700 accent-cyan-400"
        />
        <span className="w-16 shrink-0 text-right font-mono text-[10px] text-cyan-300">
          {Number(value).toFixed(
            String(meta.step ?? 0.01).includes(".") ? 3 : 0
          )}
        </span>
      </label>
    )
  }

  if (!open) {
    return null
  }

  // 最小化态：仅显示右下角浮动恢复按钮
  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed right-4 bottom-4 z-80 flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-slate-950/90 px-3.5 py-2 text-xs font-medium text-cyan-300 shadow-lg backdrop-blur-sm transition-colors hover:bg-slate-900 hover:text-cyan-200"
        aria-label="打开调试面板"
      >
        <SlidersHorizontal className="size-4" />
        Debug
      </button>
    )
  }

  return (
    <>
      {/* —— 右侧抽屉 —— */}
      <div className="fixed inset-0 z-80">
        {/* 点击遮罩最小化（不虚化背景：纯透明，仅捕获点击） */}
        <div
          className="absolute inset-0 bg-transparent"
          onClick={minimize}
          aria-hidden="true"
        />
        {/* 抽屉本体：右侧固定宽度、卡片从上到下竖列 */}
        <div className="absolute inset-y-0 right-0 flex w-85 max-w-[90vw] flex-col border-l border-white/10 bg-slate-950/95 shadow-2xl">
          {/* 顶栏 */}
          <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-slate-950 px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium text-cyan-300">
              <SlidersHorizontal className="size-4" />
              deepSea 参数调试
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={minimize}
                className="rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="最小化调试面板"
                title="最小化"
              >
                <Minimize2 className="size-4" />
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="关闭调试面板"
                title="关闭"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* 操作栏 */}
          <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2">
            <button
              type="button"
              onClick={() => setJsonOpen((v) => !v)}
              className="rounded border border-white/15 px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-white/10"
            >
              {jsonOpen ? "收起 JSON" : "JSON"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-white/10"
            >
              <RotateCcw className="size-3" />
              重置
            </button>
            <button
              type="button"
              onClick={copyJson}
              className="ml-auto flex items-center gap-1 rounded bg-cyan-500 px-2.5 py-1 text-xs font-medium text-slate-950 transition-colors hover:bg-cyan-400"
            >
              {copied ? (
                <Check className="size-3" />
              ) : (
                <Copy className="size-3" />
              )}
              {copied ? "已复制" : "复制 JSON"}
            </button>
          </div>

          {/* JSON 导出区 */}
          {jsonOpen && (
            <div className="max-h-40 overflow-auto border-b border-white/10 bg-slate-900/80 px-4 py-2">
              <pre className="rounded bg-black/50 p-2 font-mono text-[10px] leading-relaxed text-emerald-300">
                {JSON.stringify(local, null, 2)}
              </pre>
            </div>
          )}

          {/* 参数卡片：从上到下竖列排列，整列滚动 */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <div className="flex flex-col gap-3">
              {OCEAN_PARAM_GROUPS.map((group) => (
                <div
                  key={group.name}
                  className="rounded-lg border border-white/10 bg-white/5 p-3"
                >
                  <h3 className="mb-2.5 border-b border-white/10 pb-1.5 text-xs font-semibold text-slate-200">
                    {group.name}
                  </h3>
                  <div className="flex flex-col gap-2.5">
                    {group.params.map((meta) => (
                      <div key={meta.key}>{renderParam(meta)}</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// —— 手动数字输入 ——
// 用于无上限参数（如海底深度最小 10、光束长度最小 0 且不限最大）：
//   本地编辑（不打断打字），Enter / 失焦提交，非法值或低于下限自动回退。
function NumberInput({
  label,
  min,
  step,
  value,
  onCommit,
}: {
  label: string
  min: number
  step: number
  value: number
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)

  // 外部 value 变化（重置/恢复）时同步，聚焦编辑时不覆盖
  useEffect(() => {
    if (!focused) {
      setText(String(value))
    }
  }, [value, focused])

  const commit = () => {
    setFocused(false)
    const n = Number(text)
    if (Number.isFinite(n) && n >= min) {
      setText(String(n))
      onCommit(n)
    } else {
      setText(String(value))
    }
  }

  return (
    <label className="flex items-center gap-2">
      <span className="truncate text-xs text-slate-300">{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={text}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="h-7 w-full flex-1 rounded border border-white/15 bg-slate-900 px-2 font-mono text-xs text-cyan-300 transition-colors outline-none focus:border-cyan-400"
        aria-label={label}
      />
    </label>
  )
}
