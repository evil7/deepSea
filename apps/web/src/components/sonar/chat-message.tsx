// ---------------------------------------------------------------------------
// ChatMessageNode —— 单个消息节点渲染（user / assistant / tool / context / error）。
// 复刻官方 chatUI：消息无头像；用户消息右侧「时间 + 复制图标」；助手消息下方
// 「时间 + 复制图标」；上下文注入（source.kind==="plugin"）为独立折叠行。
//   · assistant reasoning block → 可折叠「思考」区
//   · assistant tool-call block + tool 结果节点 → 缩进「审计」轨迹
// ---------------------------------------------------------------------------

import { useState } from "react"
import { Check, ChevronRight, CircleAlert, Copy, Terminal, Wrench } from "lucide-react"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { AssistantBlock } from "@/lib/deepc-bridge/protocol"
import { blockText, contextLabel, type RenderNode } from "@/lib/deepc-bridge/fold"
import { Markdown } from "@/components/sonar/markdown"

/** 消息时间（同一天 HH:mm；跨天 M/D HH:mm），对齐官方 formatMessageClock。 */
function formatClock(time: number): string {
  const d = new Date(time)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
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

/** 消息操作行：时间 + 复制图标（复刻官方 MessageIconActions，hover 显现）。 */
function MessageActions({ time, text }: { time: number; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
      <span className="text-[11px] leading-none text-muted-foreground">{formatClock(time)}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        title="复制"
      >
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </button>
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

export function ChatMessageNode({ node }: { node: RenderNode }) {
  switch (node.kind) {
    case "user":
      return (
        <div className="group flex flex-col items-end">
          <Bubble variant="default" align="end">
            <BubbleContent className="whitespace-pre-wrap">
              {node.content.map(blockText).join("")}
            </BubbleContent>
          </Bubble>
          <MessageActions time={node.time} text={node.content.map(blockText).join("")} />
        </div>
      )
    case "assistant":
      return (
        <div className="group flex flex-col items-start gap-2">
          <AssistantBlocks blocks={node.blocks} />
          <MessageActions time={node.time} text={assistantText(node.blocks)} />
        </div>
      )
    case "context":
      return <ContextInjectionRow node={node} />
    case "tool":
      return <ToolResultBlock node={node} />
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

export function ChatMessageList({ nodes }: { nodes: RenderNode[] }) {
  return (
    <div className="flex flex-col gap-4">
      {nodes.map((node, i) => (
        <ChatMessageNode key={`${node.kind}-${node.seq}-${i}`} node={node} />
      ))}
    </div>
  )
}
