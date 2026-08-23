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
  AskUserQuestionItem,
  ContentBlock,
  ContextSource,
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
  | {
      kind: "error"
      seq: number
      time: number
      message: string
      code?: string
    }
  | {
      kind: "context"
      seq: number
      time: number
      content: ContentBlock[]
      source: ContextSource
    }
  | {
      kind: "question"
      seq: number
      time: number
      questions: AskUserQuestionItem[]
      answered?: boolean
    }
  | {
      kind: "approval"
      seq: number
      time: number
      approvalId: string
      toolName: string
      callId?: string
      reason?: string
      resolved?: boolean
    }

/**
 * 上下文注入的来源名（producer name）：plugin id / 指令路径 / 其他 kind。
 * 对齐 dsh `contextProvenance`：可读 label 优先，否则回退 source.kind。
 */
export function contextLabel(source: unknown): string {
  const s = source as ContextSource | null | undefined
  if (!s) return "上下文"
  if (typeof s.plugin === "string" && s.plugin.length > 0) return s.plugin
  if (Array.isArray(s.paths) && s.paths.length > 0) return s.paths[0]
  if (typeof s.kind === "string" && s.kind.length > 0) return s.kind
  return "上下文"
}

/**
 * 判定一个 `user/message` 事件的 source 应归类为「用户气泡」还是「上下文注入」。
 *
 * 官方权威判据（dsh-llm `MessageSourceMap`，merge-extensible sum type）：
 *   · source.kind === 'user'  → 普通用户输入（queued 人类 prompt）
 *   · source.kind === 'plugin'（& ContextFormed）→ agent.inject() 注入上下文
 *   · source.kind === 'goal' 等插件扩展 kind  → 目标续写 / 其它注入
 *   · 官方注释：'user/message' 三类都投影 verbatim，"source tells them apart"
 * 故唯一分类依据 = source.kind。凡 kind !== 'user' 的注入一律渲染为 context 节点。
 */
export function isUserMessage(source: unknown): boolean {
  const s = source as ContextSource | null | undefined
  if (!s) return true // 无 source 保守视为用户消息，不丢消息
  return s.kind === "user"
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
        // source.kind !== 'user'（plugin / goal / 其它注入）→ 上下文注入（独立节点）。
        // 对齐官方：「user/message 三类靠 source 区分」，kind === 'user' 才是用户气泡。
        if (!isUserMessage(data.source)) {
          nodes.push({
            kind: "context",
            seq: event.seq,
            time: event.time,
            content,
            source: (data.source ?? {}) as ContextSource,
          })
          break
        }
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
      case "turn/end": {
        // turn 结束携带错误原因时（kind === "error"），固化为错误节点。
        const data = event.data as {
          turn?: number
          reason?: { kind?: string; error?: { message?: string; code?: string } }
        }
        if (data.reason?.kind === "error" && data.reason.error?.message) {
          nodes.push({
            kind: "error",
            seq: event.seq,
            time: event.time,
            message: data.reason.error.message,
            code: data.reason.error.code,
          })
        }
        break
      }
      case "question/requested": {
        // 提问：ask_user_question tool 触发，渲染选项卡（composer 接管）。
        const data = event.data as { questions?: AskUserQuestionItem[] }
        if (Array.isArray(data.questions) && data.questions.length > 0) {
          nodes.push({
            kind: "question",
            seq: event.seq,
            time: event.time,
            questions: data.questions,
          })
        }
        break
      }
      case "approval/requested": {
        // 审批：approval/requested 触发，渲染 amber 审批条。
        const data = event.data as {
          approvalId?: string
          toolName?: string
          callId?: string
          reason?: string
        }
        nodes.push({
          kind: "approval",
          seq: event.seq,
          time: event.time,
          approvalId: data.approvalId ?? "",
          toolName: data.toolName ?? "",
          callId: data.callId,
          reason: data.reason,
        })
        break
      }
      case "approval/resolved":
      case "question/answered": {
        // 把对应挂起节点标记为已处理（answered/resolved）。
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i]
          if (n.kind === "approval" && (event.data as { approvalId?: string })?.approvalId
            && (event.data as { approvalId?: string }).approvalId === n.approvalId) {
            n.resolved = true
            break
          }
          if (n.kind === "question") {
            n.answered = true
            break
          }
        }
        break
      }
      default:
        // assistant/chunk、step/*、session/end-seed 等忽略
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
    case "error":
      return `运行失败：${node.message}`.slice(0, 120)
    case "context":
      return `上下文注入：${contextLabel(node.source)}`
    case "question":
      return node.questions?.length ? `提问：${node.questions[0].question}` : "提问"
    case "approval":
      return `待审批：${node.toolName}${node.resolved ? "（已处理）" : ""}`
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
