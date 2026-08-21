// ---------------------------------------------------------------------------
// 会话事件折叠 —— 把 session.history 的原始事件流折叠成 chatUI 渲染节点。
//
// dsh 会话事件流是细粒度的（assistant/chunk 流式分块、step/turn 边界等），
// 官方前端折叠成 conversation 节点。这里做 v1 简化折叠：
//   · user/message      → 用户节点（ContentBlock[]）
//   · assistant/message → 助手节点（text/reasoning/tool-call blocks，完整边界）
//   · tool/result       → 工具结果节点（缩进轨迹）
//   其余（assistant/chunk、step/*、turn/*、approval/* 等）忽略
// ---------------------------------------------------------------------------

import type {
  AssistantBlock,
  ContentBlock,
  HistoryEntry,
  SessionEvent,
  StreamChunk,
} from "./protocol"

export type { ContentBlock } from "./protocol"

/** 折叠后的渲染节点。 */
export type RenderNode =
  | {
      kind: "user"
      seq: number
      time: number
      content: ContentBlock[]
      source: unknown
    }
  | {
      kind: "assistant"
      seq: number
      time: number
      turn: number
      step: number
      messageId?: string
      blocks: AssistantBlock[]
      usage?: unknown
    }
  | {
      kind: "tool"
      seq: number
      time: number
      callId: string
      name: string | null
      content: ContentBlock[]
      isError: boolean
    }

/** 把 ContentBlock[] 分类为 AssistantBlock[]（text/reasoning/tool-call/other）。 */
export function classifyBlocks(content: readonly unknown[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  for (const raw of content) {
    const block = raw as ContentBlock
    switch (block.type) {
      case "text":
        blocks.push({ kind: "text", text: block.text ?? "" })
        break
      case "reasoning":
        blocks.push({
          kind: "reasoning",
          text: block.text ?? block.thinking ?? "",
        })
        break
      case "tool-call":
        blocks.push({
          kind: "tool-call",
          callId: block.id ?? "",
          name: block.name ?? "",
          argsRaw: block.arguments ?? "",
        })
        break
      case "image":
        blocks.push({ kind: "image", attachment: block })
        break
      default:
        blocks.push({ kind: "other", block })
    }
  }
  return blocks
}

/** 提取纯文本（用于列表/摘要展示）。 */
export function blockText(block: ContentBlock): string {
  if (block.type === "text") return block.text ?? ""
  if (block.type === "reasoning") return block.text ?? block.thinking ?? ""
  if (block.type === "tool-call") return block.name ?? ""
  if (block.type === "tool-result") return block.content?.map(blockText).join("") ?? ""
  return ""
}

/** 折叠事件流为渲染节点（保持时间顺序）。 */
export function foldEvents(events: HistoryEntry[]): RenderNode[] {
  const nodes: RenderNode[] = []
  // callId → 工具名（从 assistant 的 tool-call block 反查，供 tool/result 标注）。
  const callNames = new Map<string, string>()

  for (const entry of events) {
    const event: SessionEvent = entry.event
    switch (event.type) {
      case "user/message": {
        const data = event.data as { content?: ContentBlock[]; source?: unknown }
        const content = data.content ?? []
        if (content.length === 0) break
        nodes.push({
          kind: "user",
          seq: event.seq,
          time: event.time,
          content,
          source: data.source,
        })
        break
      }
      case "assistant/message": {
        const data = event.data as {
          turn?: number
          step?: number
          message?: { content?: ContentBlock[]; id?: string }
          usage?: unknown
        }
        const blocks = classifyBlocks(data.message?.content ?? [])
        // 记录 tool-call 名称映射。
        for (const b of blocks) {
          if (b.kind === "tool-call") callNames.set(b.callId, b.name)
        }
        if (blocks.length === 0) break
        nodes.push({
          kind: "assistant",
          seq: event.seq,
          time: event.time,
          turn: data.turn ?? 0,
          step: data.step ?? 0,
          messageId: data.message?.id,
          blocks,
          usage: data.usage,
        })
        break
      }
      case "tool/result": {
        const data = event.data as {
          message?: { source?: { callId?: string }; content?: ContentBlock[] }
        }
        const toolResult = data.message?.content?.find((c) => c.type === "tool-result")
        if (!toolResult) break
        const callId = toolResult.toolCallId ?? data.message?.source?.callId ?? ""
        nodes.push({
          kind: "tool",
          seq: event.seq,
          time: event.time,
          callId,
          name: callNames.get(callId) ?? null,
          content: toolResult.content ?? [],
          isError: toolResult.isError === true,
        })
        break
      }
      default:
        // assistant/chunk、step/*、turn/*、approval/*、session/end-seed 等忽略
        break
    }
  }
  return nodes
}

/** 折叠节点里提取用户/助手/工具的可读文本（用于辅助展示）。 */
export function nodeSummary(node: RenderNode): string {
  switch (node.kind) {
    case "user":
      return node.content.map(blockText).join(" ").slice(0, 120)
    case "assistant":
      return (
        node.blocks
          .filter((b) => b.kind === "text")
          .map((b) => (b.kind === "text" ? b.text : ""))
          .join(" ")
          .slice(0, 120)
      )
    case "tool":
      return `${node.name ?? node.callId}${node.isError ? "（出错）" : ""}`
  }
}

// ---------------------------------------------------------------------------
// 流式输出累积（assistant/chunk 事件 → 实时打字机效果）
//
// 对齐 dsh `PartialAccumulator` 语义：按 index 累积 delta 拼块；
// block-end 携带完整块替换该 index。返回新数组（不可变，便于 React 触发重渲染）。
// ---------------------------------------------------------------------------

/** 打开一个空块（block-start）。 */
function emptyStreamBlock(blockType: "text" | "reasoning" | "tool-call"): AssistantBlock {
  switch (blockType) {
    case "reasoning":
      return { kind: "reasoning", text: "" }
    case "tool-call":
      return { kind: "tool-call", callId: "", name: "", argsRaw: "" }
    default:
      return { kind: "text", text: "" }
  }
}

/** 把 dsh ContentBlock 转成 AssistantBlock（block-end 最终态）。 */
function contentBlockToAssistant(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case "reasoning":
      return { kind: "reasoning", text: block.text ?? block.thinking ?? "" }
    case "tool-call":
      return {
        kind: "tool-call",
        callId: block.id ?? "",
        name: block.name ?? "",
        argsRaw: block.arguments ?? "",
      }
    case "image":
      return { kind: "image", attachment: block }
    case "text":
      return { kind: "text", text: block.text ?? "" }
    default:
      return { kind: "other", block }
  }
}

/**
 * 应用一个 StreamChunk 到当前累积块，返回新块数组。
 * 传入当前块（可为空数组）与一个 chunk，返回累积后的新数组。
 */
export function applyStreamChunk(
  blocks: readonly AssistantBlock[],
  chunk: StreamChunk
): AssistantBlock[] {
  const next = [...blocks]
  switch (chunk.type) {
    case "block-start": {
      next[chunk.index] = emptyStreamBlock(chunk.blockType)
      break
    }
    case "text-delta": {
      const prev = next[chunk.index]
      next[chunk.index] = {
        kind: "text",
        text: (prev?.kind === "text" ? prev.text : "") + chunk.text,
      }
      break
    }
    case "reasoning-delta": {
      const prev = next[chunk.index]
      next[chunk.index] = {
        kind: "reasoning",
        text: (prev?.kind === "reasoning" ? prev.text : "") + chunk.text,
      }
      break
    }
    case "tool-call-delta": {
      const prev = next[chunk.index]
      const base: AssistantBlock =
        prev?.kind === "tool-call"
          ? prev
          : { kind: "tool-call", callId: "", name: "", argsRaw: "" }
      next[chunk.index] = {
        kind: "tool-call",
        callId: base.callId || chunk.id,
        name: chunk.name ?? base.name,
        argsRaw: base.argsRaw + chunk.argumentsDelta,
      }
      break
    }
    case "block-end": {
      next[chunk.index] = contentBlockToAssistant(chunk.block)
      break
    }
    case "usage":
    case "finish":
      // 用量/结束标记不产生可见内容。
      break
  }
  return next
}
