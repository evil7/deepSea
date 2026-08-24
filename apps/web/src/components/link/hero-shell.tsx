// ---------------------------------------------------------------------------
// HeroShell —— 无会话 / 新建会话时的 hero 空态（复刻官方 HeroShell）。
//
// 居中显示：headline（deepseek 标识 + 标语）+ 工作区 / Agent 预设参数 chip +
// 中央输入卡（composer slot）。用户在此快速设定新会话参数并输入首条消息。
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronDown, Folder, Plus, Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"
import type { AgentPresetEntry, WorkspaceView } from "@/lib/deepc-link/protocol"

export interface HeroShellProps {
  /** 已注册工作区（排除未分组）。 */
  workspaces: WorkspaceView[]
  /** 可选（未 broken）的 agent 预设。 */
  presetOptions: AgentPresetEntry[]
  /** 当前生效的工作区 cwd。 */
  effectiveCwd: string | undefined
  /** 工作区显示名（cwd 末段）。 */
  cwdLabel: string
  /** 当前生效的预设 id。 */
  effectivePreset: string | undefined
  /** 当前生效预设的显示名。 */
  presetName: string | undefined
  /** 选择工作区 cwd。 */
  onSelectCwd: (cwd: string) => void
  /** 选择 agent 预设。 */
  onSelectPreset: (id: string) => void
  /** 浏览文件夹选择工作区。 */
  onBrowseFolder: () => void
  /** 中央输入卡（由父组件注入 <Composer>）。 */
  composer: ReactNode
}

export function HeroShell({
  workspaces,
  presetOptions,
  effectiveCwd,
  cwdLabel,
  effectivePreset,
  presetName,
  onSelectCwd,
  onSelectPreset,
  onBrowseFolder,
  composer,
}: HeroShellProps) {
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const paramsRef = useRef<HTMLDivElement | null>(null)

  // 参数菜单：点击外部收起。
  useEffect(() => {
    if (!workspaceMenuOpen && !presetMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (paramsRef.current && !paramsRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false)
        setPresetMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [workspaceMenuOpen, presetMenuOpen])

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="flex w-full max-w-xl flex-col items-center gap-4">
        {/* headline：deepseek 标识 + 标语 */}
        <div className="flex items-center gap-2.5">
          <img
            src="/deepseek.svg"
            alt=""
            aria-hidden
            className="size-8 shrink-0 opacity-90 dark:invert"
          />
          <span className="text-2xl font-medium tracking-tight text-foreground">
            探索未至之境
          </span>
        </div>

        {/* 参数行：工作区 + Agent 预设（快速设定新会话参数） */}
        <div ref={paramsRef} className="flex flex-wrap items-center justify-center gap-1.5">
          {/* 工作区 chip */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setWorkspaceMenuOpen((v) => !v)
                setPresetMenuOpen(false)
              }}
              className={cn(
                "flex max-w-70 items-center gap-1.5 rounded-2xl px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/60",
                workspaceMenuOpen && "bg-muted/60"
              )}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{cwdLabel}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
            {workspaceMenuOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-border/60 bg-background p-1 text-left shadow-xl">
                {workspaces.map((ws) => (
                  <button
                    key={ws.workspaceId}
                    type="button"
                    onClick={() => {
                      onSelectCwd(ws.path)
                      setWorkspaceMenuOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/60"
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{ws.title || ws.path}</span>
                    {effectiveCwd === ws.path && <span className="shrink-0 text-emerald-400">✓</span>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceMenuOpen(false)
                    onBrowseFolder()
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                >
                  <Plus className="size-3.5" />
                  浏览文件夹…
                </button>
              </div>
            )}
          </div>

          {/* Agent 预设 chip */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setPresetMenuOpen((v) => !v)
                setWorkspaceMenuOpen(false)
              }}
              className={cn(
                "flex max-w-60 items-center gap-1.5 rounded-2xl px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/60",
                presetMenuOpen && "bg-muted/60"
              )}
            >
              <Sparkles className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 truncate">{presetName ?? "Agent 预设"}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
            {presetMenuOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-border/60 bg-background p-1 text-left shadow-xl">
                {presetOptions.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">无可用预设</p>
                ) : (
                  presetOptions.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        onSelectPreset(p.id)
                        setPresetMenuOpen(false)
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name ?? p.id}</span>
                      {effectivePreset === p.id && <span className="shrink-0 text-emerald-400">✓</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* 中央输入卡（composer） */}
        {composer}
      </div>
    </div>
  )
}
