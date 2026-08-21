// ---------------------------------------------------------------------------
// ChatMessageNode —— 单个消息节点渲染（user / assistant / tool）。
// 复用 shadcn message/bubble/collapsible 组件，复刻官方「思考 + 审计」板块：
//   · assistant reasoning block → 可折叠「思考」区
//   · assistant tool-call block + tool 结果节点 → 缩进「审计」轨迹
// ---------------------------------------------------------------------------

import { useState } from "react"
import { ChevronRight, Terminal, Wrench } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
} from "@/components/ui/message"
import { cn } from "@/lib/utils"
import type { AssistantBlock } from "@/lib/deepc-bridge/protocol"
import { blockText, type RenderNode } from "@/lib/deepc-bridge/fold"

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
                <BubbleContent className="whitespace-pre-wrap">
                  {block.text}
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

export function ChatMessageNode({ node }: { node: RenderNode }) {
  switch (node.kind) {
    case "user":
      return (
        <Message align="end">
          <MessageContent>
            <Bubble variant="default" align="end">
              <BubbleContent className="whitespace-pre-wrap">
                {node.content.map(blockText).join("")}
              </BubbleContent>
            </Bubble>
          </MessageContent>
          <MessageAvatar>
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">U</AvatarFallback>
            </Avatar>
          </MessageAvatar>
        </Message>
      )
    case "assistant":
      return (
        <Message align="start">
          <MessageAvatar>
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">AI</AvatarFallback>
            </Avatar>
          </MessageAvatar>
          <MessageContent className="gap-2">
            <AssistantBlocks blocks={node.blocks} />
          </MessageContent>
        </Message>
      )
    case "tool":
      return <ToolResultBlock node={node} />
    default:
      return null
  }
}

export function ChatMessageList({ nodes }: { nodes: RenderNode[] }) {
  return (
    <MessageGroup>
      {nodes.map((node, i) => (
        <ChatMessageNode key={`${node.kind}-${node.seq}-${i}`} node={node} />
      ))}
    </MessageGroup>
  )
}
