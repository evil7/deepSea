// ---------------------------------------------------------------------------
// Composer —— chatUI 输入框（含工具栏：命令 / 访问模式 / 模型 / 发送 + 统计）。
//
// 自管理输入态（draft / 联想 / 下拉菜单），hero 空态与已选会话底部两处复用。
// 发送逻辑由父组件经 onSend 注入（已选会话 → session.prompt；hero 空态 →
// 建会话 + 发首条消息）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronDown,
  CircleAlert,
  Loader2,
  Plus,
  SendHorizonal,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  CommandItem,
  ModelSelection,
  PendingInteraction,
} from "@/lib/deepc-link/protocol"

/** 访问模式（composer 工具栏，对齐官方英文 label）。 */
const ACCESS_MODES = [
  { value: "read-only", label: "Read Only" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "Full access" },
]

/** 内置 slash 命令（对齐官方命令面板）。 */
const SLASH_COMMANDS: { id: string; name: string; desc: string }[] = [
  { id: "compact", name: "compact", desc: "Compact older conversation history" },
  { id: "export", name: "export", desc: "Download this Session log as a ZIP archive" },
  { id: "feedback", name: "feedback", desc: "record feedback about this session" },
  { id: "goal", name: "goal", desc: "set or view the goal for a long-running task" },
  { id: "permission", name: "permission", desc: "Switch the permission preset (sandbox mode + approval policy)" },
  { id: "plan", name: "plan", desc: "Enter or leave plan mode" },
  { id: "model", name: "model", desc: "选择本会话使用的模型" },
]

/** 扁平化后的可选模型项（session.models 派生）。 */
export interface ComposerModelOption {
  provider: string
  id: string
  name: string
  reasoning?: { efforts?: { id: string; name: string }[]; defaultEffort?: string }
}

export interface ComposerProps {
  /** 当前选中会话 id；hero 空态为 null（发送走建会话流程）。 */
  activeSessionId: string | null
  /** 渲染变体：hero = 中央大卡（无分隔线/统计）；bottom = 底部固定栏。 */
  variant?: "hero" | "bottom"
  /** 当前访问模式（permission.defaultPreset）。 */
  permission: string
  /** 访问模式显示名。 */
  accessModeLabel: string
  /** 当前模型选择。 */
  currentModel: ModelSelection | null
  /** 可选模型列表。 */
  modelOptions: ComposerModelOption[]
  /** 当前模型对应的目录项。 */
  currentModelEntry: ComposerModelOption | undefined
  /** 当前模型可用的推理等级。 */
  reasoningEfforts: { id: string; name: string }[]
  /** 会话统计（turns/steps）。 */
  sessionStats: { turns: number; steps: number }
  /** 挂起的交互（提问/审批等待），顶部提示条。 */
  pendingInteractions: PendingInteraction[]
  /** 发送文本（父组件决定建会话 or 发消息）。 */
  onSend: (text: string) => void
  /** 切换模型。 */
  onSelectModel: (provider: string, model: string, effort?: string) => void
  /** 切换访问模式。 */
  onSetPermission: (preset: string) => void
  /** 查询 dsh 已注册 slash 命令（供 `/` 联想）。 */
  loadCommands: (sessionId: string) => Promise<CommandItem[]>
}

export function Composer({
  activeSessionId,
  variant = "bottom",
  permission,
  accessModeLabel,
  currentModel,
  modelOptions,
  currentModelEntry,
  reasoningEfforts,
  sessionStats,
  pendingInteractions,
  onSend,
  onSelectModel,
  onSetPermission,
  loadCommands,
}: ComposerProps) {
  const [draft, setDraft] = useState("")
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState("")
  const [slashItems, setSlashItems] = useState<CommandItem[]>([])
  const [slashLoading, setSlashLoading] = useState(false)
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)

  const editorRef = useRef<HTMLDivElement | null>(null)
  const slashRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  const closeToolbarMenus = useCallback(() => {
    setCommandMenuOpen(false)
    setPermissionMenuOpen(false)
    setModelMenuOpen(false)
  }, [])

  /**
   * 把命令插入 composer（复刻官方：不自动发送，命令词用 <mark> 高亮）。
   * 追加 `/command `；若末尾已有内容，前面补一个空格。
   */
  const insertCommand = useCallback((commandId: string) => {
    const editor = editorRef.current
    if (!editor) return
    setCommandMenuOpen(false)
    setPermissionMenuOpen(false)
    setModelMenuOpen(false)
    const text = editor.textContent ?? ""
    const prevGap = text.length > 0 && !text.endsWith(" ") ? " " : ""
    const mark = document.createElement("mark")
    mark.textContent = `/${commandId}`
    const space = document.createElement("span")
    space.textContent = " "
    editor.appendChild(document.createTextNode(prevGap))
    editor.appendChild(mark)
    editor.appendChild(space)
    setDraft(editor.textContent ?? "")
    const sel = window.getSelection()
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    editor.focus()
  }, [])

  /**
   * 输入框 `/` 命令联想（对齐官方 composer：末尾输入 `/` 或 `/xxx` 时，
   * 动态查询 dsh 已注册命令并弹出联想下拉）。
   */
  const handleSlashEdit = useCallback(
    async (text: string) => {
      const trimmed = text.trimEnd()
      const lastToken = trimmed.split(/\s+/).pop() ?? ""
      if (lastToken.startsWith("/") && lastToken.length > 1 && activeSessionId) {
        const q = lastToken.slice(1).toLowerCase()
        setSlashOpen(true)
        setSlashQuery(q)
        setSlashLoading(true)
        try {
          const all = await loadCommands(activeSessionId)
          const filtered = q ? all.filter((c) => c.name.includes(q)) : all
          setSlashItems(filtered)
        } catch {
          setSlashItems([])
        } finally {
          setSlashLoading(false)
        }
      } else {
        setSlashOpen(false)
        setSlashItems([])
      }
    },
    [activeSessionId, loadCommands]
  )

  // 点击联选项外收起 `/` 联想。
  useEffect(() => {
    if (!slashOpen) return
    const onDown = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) {
        setSlashOpen(false)
        setSlashItems([])
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [slashOpen])

  // 点击工具栏外部时收起下拉。
  useEffect(() => {
    if (!commandMenuOpen && !permissionMenuOpen && !modelMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        closeToolbarMenus()
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [commandMenuOpen, permissionMenuOpen, modelMenuOpen, closeToolbarMenus])

  const handleSend = () => {
    const text = draft.trim()
    if (!text) return
    // 清空 contenteditable 的实际 DOM 文本（draft 是受控 state，但 DOM 非受控，
    // 只 setDraft("") 不会清掉编辑器里的字，导致「已发送消息卡在输入框」）。
    if (editorRef.current) editorRef.current.textContent = ""
    setDraft("")
    onSend(text)
  }

  const isHero = variant === "hero"

  const card = (
    <div
      className={cn(
        "relative w-full transition-colors focus-within:border-ring",
        isHero
          ? "rounded-3xl border border-border/70 bg-background/70 px-4 py-3 shadow-sm"
          : "rounded-xl border border-border/80 bg-muted/40 px-3 py-2"
      )}
    >
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={isHero ? "描述你想要构建的内容" : activeSessionId ? "发送消息…" : "描述你想要构建的内容"}
        data-empty={!draft}
        className={cn(
          "w-full resize-none border-0 bg-transparent px-0 py-0 text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)] [&_mark]:rounded [&_mark]:bg-primary/15 [&_mark]:px-0.5 [&_mark]:text-foreground",
          isHero ? "min-h-16 text-base leading-7" : "min-h-10 text-sm leading-6"
        )}
        onInput={(e) => {
          const text = (e.target as HTMLDivElement).textContent ?? ""
          setDraft(text)
          void handleSlashEdit(text)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && slashOpen) {
            setSlashOpen(false)
            setSlashItems([])
            return
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            handleSend()
          }
        }}
      />
      {/* 输入框 / 命令联想下拉 */}
      {slashOpen && activeSessionId && (
        <div
          ref={slashRef}
          className="absolute inset-x-4 z-30 mx-auto max-w-3xl overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl"
          style={{ bottom: "calc(100% + 8px)" }}
        >
          <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            命令
          </p>
          {slashLoading ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              加载命令…
            </div>
          ) : slashItems.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">无匹配命令</p>
          ) : (
            slashItems.map((c) => {
              const q = slashQuery
              const idx = q ? c.name.toLowerCase().indexOf(q) : -1
              const name = `/${c.name}`
              const matched =
                idx >= 0 ? (
                  <>
                    {name.slice(0, idx + 1)}
                    <mark className="rounded-sm bg-primary/20 px-0.5 text-primary">
                      {name.slice(idx + 1, idx + 1 + q.length)}
                    </mark>
                    {name.slice(idx + 1 + q.length)}
                  </>
                ) : (
                  name
                )
              return (
                <button
                  key={c.name}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                  onClick={() => {
                    insertCommand(c.name)
                    setSlashOpen(false)
                    setSlashItems([])
                  }}
                >
                  <span className="font-mono text-xs font-medium text-foreground">{matched}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {c.description}
                  </span>
                  {c.hint && <span className="shrink-0 text-[10px] text-muted-foreground/60">{c.hint}</span>}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )

  const toolbar = (
    <div ref={toolbarRef} className={cn("flex items-center justify-between gap-2", isHero ? "mt-2" : "pb-1.5")}>
      <div className="flex items-center gap-1">
        {/* 命令按钮（+） */}
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-muted-foreground", isHero ? "size-8" : "size-7")}
            title="命令"
            onClick={() => {
              setCommandMenuOpen((v) => !v)
              setPermissionMenuOpen(false)
              setModelMenuOpen(false)
            }}
          >
            <Plus className="size-4" />
          </Button>
          {commandMenuOpen && (
            <div className="absolute bottom-full left-0 z-30 mb-1 w-72 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                命令
              </p>
              {SLASH_COMMANDS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                  onClick={() => {
                    if (c.id === "model") setModelMenuOpen(true)
                    else if (c.id === "permission") setPermissionMenuOpen(true)
                    else if (activeSessionId) insertCommand(c.id)
                  }}
                >
                  <span className="text-xs font-medium text-foreground">{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {c.desc}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 访问模式 */}
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            className={cn("gap-1.5 text-xs text-muted-foreground", isHero ? "h-8" : "h-7")}
            title={`访问模式，当前：${accessModeLabel}`}
            onClick={() => {
              setPermissionMenuOpen((v) => !v)
              setCommandMenuOpen(false)
              setModelMenuOpen(false)
            }}
          >
            {accessModeLabel}
            <ChevronDown className="size-3.5" />
          </Button>
          {permissionMenuOpen && (
            <div className="absolute bottom-full left-0 z-30 mb-1 w-48 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
              {ACCESS_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                    m.value === permission ? "text-foreground" : "text-muted-foreground"
                  )}
                  onClick={() => {
                    setPermissionMenuOpen(false)
                    onSetPermission(m.value)
                  }}
                >
                  {m.label}
                  {m.value === permission && <span className="text-emerald-400">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 统计仅底部显示（hero 无多余元素） */}
      {!isHero && (
        <div className="flex items-center text-xs text-muted-foreground/70">
          {sessionStats.turns} 轮 · {sessionStats.steps} 步
        </div>
      )}

      <div className="flex items-center gap-1">
        {/* 模型选择 */}
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            className={cn("gap-1.5 text-xs text-muted-foreground", isHero ? "h-8" : "h-7")}
            title={`选择模型，当前 ${currentModelEntry?.name ?? currentModel?.model ?? "选择模型"}，推理等级 ${currentModel?.reasoningEffort ?? "-"}`}
            onClick={() => {
              setModelMenuOpen((v) => !v)
              setCommandMenuOpen(false)
              setPermissionMenuOpen(false)
            }}
          >
            {currentModelEntry?.name ?? currentModel?.model ?? "选择模型"}
            <ChevronDown className="size-3.5" />
          </Button>
          {modelMenuOpen && (
            <div className="absolute bottom-full right-0 z-30 mb-1 w-56 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                模型
              </p>
              {modelOptions.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                    m.id === currentModel?.model ? "text-foreground" : "text-muted-foreground"
                  )}
                  onClick={() => {
                    if (activeSessionId) {
                      onSelectModel(m.provider, m.id, currentModel?.reasoningEffort)
                    }
                  }}
                >
                  {m.name}
                  {m.id === currentModel?.model && <span className="text-emerald-400">✓</span>}
                </button>
              ))}
              {reasoningEfforts.length > 0 && (
                <>
                  <p className="mt-1 border-t border-border/40 px-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    推理等级
                  </p>
                  {reasoningEfforts.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                        e.id === currentModel?.reasoningEffort ? "text-foreground" : "text-muted-foreground"
                      )}
                      onClick={() => {
                        if (activeSessionId && currentModel) {
                          onSelectModel(currentModel.provider, currentModel.model, e.id)
                        }
                      }}
                    >
                      {e.name}
                      {e.id === currentModel?.reasoningEffort && <span className="text-emerald-400">✓</span>}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <Button
          onClick={handleSend}
          disabled={!draft.trim()}
          size="icon"
          className={isHero ? "size-8" : "size-7"}
          title="发送消息"
        >
          <SendHorizonal className="size-4" />
        </Button>
      </div>
    </div>
  )

  // hero：干净大卡（无横线、无统计）；bottom：带 border-t 分隔线的底部栏。
  if (isHero) {
    return (
      <div className="w-full">
        {pendingInteractions.length > 0 && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <CircleAlert className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              {pendingInteractions[0].kind === "question"
                ? "等待回答：请在下方回答问题"
                : `等待授权：${pendingInteractions[0].toolName ?? ""}`}
            </span>
          </div>
        )}
        {card}
        {toolbar}
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-border/60">
      {pendingInteractions.length > 0 && (
        <div className="mx-auto max-w-3xl px-4 pt-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <CircleAlert className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              {pendingInteractions[0].kind === "question"
                ? "等待回答：请在下方回答问题"
                : `等待授权：${pendingInteractions[0].toolName ?? ""}`}
            </span>
          </div>
        </div>
      )}
      <div className="mx-auto max-w-3xl px-4 pt-2.5 pb-1.5">{card}</div>
      <div className="mx-auto max-w-3xl px-4">{toolbar}</div>
    </div>
  )
}
