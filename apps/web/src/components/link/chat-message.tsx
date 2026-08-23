// ---------------------------------------------------------------------------
// ChatMessageNode —— 单个消息节点渲染（user / assistant / tool / context / error）。
// 复刻官方 chatUI：消息无头像；用户消息右侧「时间 + 复制图标」；助手消息下方
// 「时间 + 复制图标」；上下文注入（source.kind==="plugin"）为独立折叠行。
//   · assistant reasoning block → 可折叠「思考」区
//   · assistant tool-call block + tool 结果节点 → 缩进「审计」轨迹
// ---------------------------------------------------------------------------

import { useState } from "react"
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  GitBranch,
  Terminal,
  Wrench,
} from "lucide-react"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { AssistantBlock } from "@/lib/deepc-link/protocol"
import { blockText, contextLabel, type RenderNode } from "@/lib/deepc-link/fold"
import { Markdown } from "@/components/link/markdown"

/** 消息时间（同一天 HH:mm；跨天 M/D HH:mm），对齐官方 formatMessageClock。 */
function formatClock(time: number): string {
  const d = new Date(time)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

/** 把不足 1k 的数字格式化成可读（如 63.4K / 496），对齐官方 token 缩写。 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ""
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}K`
  }
  return String(Math.round(n))
}

/**
 * 从 usage 对象提取速度/用量元数据（容错解析，缺字段一律降级）。
 * 对齐官方元数据行：`13:55 · 输出 496 tok · 111 tok/s`。
 *
 * usage 结构兼容 dsh/OpenAI 风格：
 *   · { completion_tokens, prompt_tokens, total_tokens }
 *   · { completionTokens, promptTokens, totalTokens }
 *   · { input_tokens, output_tokens, total_tokens }（Response Usage）
 * 若函数能从 usage 算出 tok/s（输出 token / 生成秒），附加显示；否则只显示时间。
 */
function formatMessageMeta(time: number, usage: unknown): string {
  const parts: string[] = [formatClock(time)]
  if (!usage || typeof usage !== "object") return parts.join(" · ")

  const u = usage as Record<string, unknown>
  // 记录外部毫秒时间戳（time 已是 event.time ms），用于估算生成时长。
  const timeMs: number | undefined = typeof time === "number" && Number.isFinite(time) ? time : undefined
  const nowMs = Date.now()
  const genSec =
    timeMs && nowMs > timeMs ? Math.max(1, (nowMs - timeMs) / 1000) : undefined

  // 输出 token（多命名兼容）。
  const completion =
    typeof u.completion_tokens === "number"
      ? u.completion_tokens
      : typeof u.output_tokens === "number"
        ? u.output_tokens
        : typeof u.completionTokens === "number"
          ? u.completionTokens
          : undefined
  // 输入 token。
  const prompt =
    typeof u.prompt_tokens === "number"
      ? u.prompt_tokens
      : typeof u.input_tokens === "number"
        ? u.input_tokens
        : typeof u.promptTokens === "number"
          ? u.promptTokens
          : undefined

  // 输出 token 用量。
  if (completion != null && Number.isFinite(completion)) {
    parts.push(`输出 ${formatTokens(completion)} tok`)
  } else if (prompt != null && Number.isFinite(prompt)) {
    parts.push(`输入 ${formatTokens(prompt)} tok`)
  }
  // 总用量。
  const total =
    typeof u.total_tokens === "number"
      ? u.total_tokens
      : typeof u.totalTokens === "number"
        ? u.totalTokens
        : undefined
  if (total != null && Number.isFinite(total) && completion == null) {
    parts.push(`共 ${formatTokens(total)} tok`)
  }

  // 生成速度 n tok/s（输出 token / 生成秒）。
  if (completion != null && genSec && genSec >= 1) {
    const tps = completion / genSec
    if (Number.isFinite(tps) && tps > 0) {
      parts.push(`${Math.round(tps)} tok/s`)
    }
  }

  return parts.join(" · ")
}

/** 助手消息内容块渲染（text / reasoning / tool-call / image / other）。 */
function AssistantBlocks({ blocks }: { blocks: readonly AssistantBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "reasoning":
            return (
              <ReasoningBlock key={i} text={block.text} />
            )
          case "tool-call":
            return (
              <ToolCallBlock key={i} name={block.name} argsRaw={block.argsRaw} />
            )
          case "text":
            return (
              <Bubble key={i} variant="muted" align="start">
                <BubbleContent>
                  <Markdown text={block.text} />
                </BubbleContent>
              </Bubble>
            )
          case "image":
            return (
              <Bubble key={i} variant="muted" align="start">
                <BubbleContent className="text-xs text-muted-foreground">
                  [图片附件]
                </BubbleContent>
              </Bubble>
            )
          default:
            return null
        }
      })}
    </>
  )
}

/** 思考板块：可折叠 reasoning。 */
function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        思考过程
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
        {text}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** 工具调用卡（审计轨迹：名称 + 参数摘要）。 */
function ToolCallBlock({ name, argsRaw }: { name: string; argsRaw: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 font-mono text-xs text-foreground/80"
      >
        <Wrench className="size-3.5 text-amber-400" />
        {name || "(工具调用)"}
      </button>
      {open && (
        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
          {argsRaw}
        </pre>
      )}
    </div>
  )
}

/** 工具结果节点（缩进轨迹卡片）。 */
function ToolResultBlock({ node }: { node: Extract<RenderNode, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false)
  const text = node.content.map(blockText).join("")
  return (
    <div className="ml-6 rounded-lg border border-border/50 bg-muted/20 px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 font-mono text-xs"
      >
        <Terminal className={cn("size-3.5", node.isError ? "text-rose-400" : "text-cyan-400")} />
        <span className="text-foreground/80">{node.name ?? node.callId}</span>
        {node.isError && <span className="text-rose-400">（出错）</span>}
      </button>
      {open && (
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
          {text.slice(0, 4000)}
        </pre>
      )}
    </div>
  )
}

/** 上下文注入行（复刻官方 ContextInjectionRow：标题 + 来源名 + 折叠 body）。 */
function ContextInjectionRow({ node }: { node: Extract<RenderNode, { kind: "context" }> }) {
  const [open, setOpen] = useState(false)
  const label = contextLabel(node.source)
  const sections = node.source.sections ?? []
  const text = node.content.map(blockText).join("")
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 text-xs font-medium text-foreground/80">上下文注入</span>
        <span className="mx-1 h-3 w-px shrink-0 bg-border" />
        <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-5">
          {node.source.form === "snapshot" && (
            <p className="text-xs text-muted-foreground/70">取代先前的快照</p>
          )}
          {sections.length > 0 ? (
            <dl className="space-y-1.5">
              {sections.map((s, i) => (
                <div key={i}>
                  {s.name && (
                    <dt className="font-mono text-[11px] font-medium text-muted-foreground">{s.name}</dt>
                  )}
                  {s.text && (
                    <dd className="mt-0.5 text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap">
                      {s.text}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap">{text}</p>
          )}
        </div>
      )}
    </div>
  )
}

/** 提问选项卡（复刻官方 ask_user_question 问题卡：题干 + 选项 + 自定义输入 + 分页 + 跳过/提交）。 */
function QuestionBlock({ node }: { node: Extract<RenderNode, { kind: "question" }> }) {
  const [idx, setIdx] = useState(0)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState("")
  const q = node.questions[idx]
  if (!q) return null
  const sel = selected[q.id] ?? []
  const answered = sel.length > 0 || custom.trim().length > 0

  return (
    <div className="w-full rounded-xl border border-border/60 bg-background/60 p-3 shadow-sm">
      {q.header && <div className="text-[11px] font-medium text-muted-foreground">{q.header}</div>}
      <div className="mt-1 text-sm font-medium text-foreground">{q.question}</div>
      {q.detail && <div className="mt-1 text-xs text-muted-foreground">{q.detail}</div>}
      {q.options && q.options.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {q.options.map((opt) => {
            const active = sel.includes(opt.label)
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  setSelected((prev) => {
                    const cur = prev[q.id] ?? []
                    if (q.multiSelect) {
                      return { ...prev, [q.id]: active ? cur.filter((l) => l !== opt.label) : [...cur, opt.label] }
                    }
                    return { ...prev, [q.id]: [opt.label] }
                  })
                  if (!q.multiSelect) setIdx((i) => Math.min(i + 1, node.questions.length - 1))
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                  )}
                >
                  {active && "✓"}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{opt.label}</span>
                  {opt.description && (
                    <span className="block text-xs text-muted-foreground">{opt.description}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
      <input
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        placeholder="输入你的答案"
        className="mt-2 h-9 w-full rounded-lg border border-border/60 bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-ring"
      />
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <button
            type="button"
            disabled={idx === 0}
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-muted/60 disabled:opacity-40"
          >
            ‹
          </button>
          <span>{idx + 1} / {node.questions.length}</span>
          <button
            type="button"
            disabled={idx >= node.questions.length - 1}
            onClick={() => setIdx((i) => Math.min(node.questions.length - 1, i + 1))}
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-muted/60 disabled:opacity-40"
          >
            ›
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIdx((i) => Math.min(node.questions.length - 1, i + 1))}
            className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
          >
            跳过本题
          </button>
          <button
            type="button"
            disabled={!answered}
            className="rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity disabled:opacity-40"
          >
            提交
          </button>
        </div>
      </div>
    </div>
  )
}

/** 审批条（复刻官方 ApprovalPanel：amber 条 + reason + 允许/拒绝）。 */
function ApprovalBlock({ node }: { node: Extract<RenderNode, { kind: "approval" }> }) {
  const [resolved, setResolved] = useState(false)
  if (resolved || node.resolved) return null
  return (
    <div className="flex w-full items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-amber-300">等待授权</div>
        <div className="mt-0.5 font-mono text-xs text-foreground/90">{node.toolName}</div>
        {node.reason && (
          <div className="mt-1 wrap-break-word text-xs text-muted-foreground">{node.reason}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setResolved(true)}
          className="rounded-lg px-2.5 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10"
        >
          允许
        </button>
        <button
          type="button"
          onClick={() => setResolved(true)}
          className="rounded-lg px-2.5 py-1 text-xs text-rose-300 transition-colors hover:bg-rose-500/10"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}

/**
 * 消息操作行：copy / like / dislike / fork / 时钟（对齐官方 MessageIconActions）。
 * 默认图标常驻弱色，时钟弱色；hover 相互淡入。copy 成功 1s 变 check。
 *
 * 【交互对齐官方】：
 *   · 用户消息：只保留「复制」按钮（无时间/点赞等）。
 *   · 助手消息：复制 + 点赞 + 点踩 + 分支 + 元数据统计，hover 消息行才浮现
 *     （平时 opacity-0，group-hover 淡入），与官方「hover 显示操作」一致。
 */
function MessageActions({
  time,
  text,
  kind,
  seq,
  usage,
  onFork,
}: {
  time: number
  text: string
  kind: "user" | "assistant"
  seq: number
  usage?: unknown
  onFork?: (atSeq: number) => void
}) {
  const [copied, setCopied] = useState(false)
  const iconCls =
    "flex size-7 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"

  const writeText = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }

  // 用户消息：只保留复制按钮（hover 淡入，对齐官方用户气泡的极简操作）。
  if (kind === "user") {
    return (
      <div className="flex items-center gap-0.5 text-[11px] leading-none text-muted-foreground">
        <button
          type="button"
          className={cn(iconCls, "opacity-0 transition-opacity group-hover:opacity-100")}
          title="复制"
          onClick={writeText}
        >
          {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-0.5 text-[11px] leading-none text-muted-foreground">
      {/* copy（常驻弱色，hover 高亮） */}
      <button type="button" className={iconCls} title="复制" onClick={writeText}>
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </button>
      {/* 操作按钮：hover 消息行才浮现 */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {/* fork / branch */}
        {onFork && (
          <button type="button" className={iconCls} title="在新对话中分叉" onClick={() => onFork(seq)}>
            <GitBranch className="size-3.5" />
          </button>
        )}
      </div>
      {/* 元数据统计：hover 消息行显示（时间 · token 用量 · tok/s 速度） */}
      <span className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {formatMessageMeta(time, usage)}
      </span>
    </div>
  )
}

/** 提取 assistant 可见文本（text 块，不含 reasoning 思考）。 */
function assistantText(blocks: readonly AssistantBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join("\n\n")
}

export function ChatMessageNode({
  node,
  onFork,
}: {
  node: RenderNode
  onFork?: (atSeq: number) => void
}) {
  switch (node.kind) {
    case "user":
      return (
        <div className="group flex flex-col items-end">
          <Bubble variant="default" align="end">
            <BubbleContent className="whitespace-pre-wrap">
              {node.content.map(blockText).join("")}
            </BubbleContent>
          </Bubble>
          <MessageActions
            time={node.time}
            text={node.content.map(blockText).join("")}
            kind="user"
            seq={node.seq}
            onFork={onFork}
          />
        </div>
      )
    case "assistant":
      return (
        <div className="group flex flex-col items-start gap-2">
          <AssistantBlocks blocks={node.blocks} />
          <MessageActions
            time={node.time}
            text={assistantText(node.blocks)}
            kind="assistant"
            seq={node.seq}
            usage={node.usage}
            onFork={onFork}
          />
        </div>
      )
    case "context":
      return <ContextInjectionRow node={node} />
    case "tool":
      return <ToolResultBlock node={node} />
    case "question":
      return <QuestionBlock node={node} />
    case "approval":
      return <ApprovalBlock node={node} />
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-400" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-rose-300">本轮运行失败</div>
            <div className="mt-1 wrap-break-word text-xs leading-relaxed text-rose-200/90">
              {node.message}
            </div>
            {node.code && (
              <code className="mt-1.5 inline-block rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[11px] text-rose-300">
                {node.code}
              </code>
            )}
          </div>
        </div>
      )
    default:
      return null
  }
}

export function ChatMessageList({
  nodes,
  onFork,
}: {
  nodes: RenderNode[]
  onFork?: (atSeq: number) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {nodes.map((node, i) => (
        <ChatMessageNode
          key={`${node.kind}-${node.seq}-${i}`}
          node={node}
          onFork={onFork}
        />
      ))}
    </div>
  )
}
