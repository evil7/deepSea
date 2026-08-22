// ---------------------------------------------------------------------------
// Markdown —— 助手消息文本的 Markdown 渲染（复刻官方前端）。
//
// react-markdown + remark-gfm（表格/任务列表/删除线）+ rehype-sanitize（防 XSS）。
// 自定义 components 贴合深蓝玻璃配色：代码块/表格/列表/引用/链接/标题。
// 代码块无语法高亮（未引入 shiki/highlight.js），但有等宽字体 + 独立背景。
// ---------------------------------------------------------------------------

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"

// 允许 fenced code 块的 language-* className（用于区分块级/内联代码）。
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
  },
}

const components: Components = {
  pre({ children }) {
    return (
      <pre className="my-2 overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3">
        {children}
      </pre>
    )
  },
  code({ className, children }) {
    const isBlock = typeof className === "string" && className.includes("language-")
    if (isBlock) {
      return <code className="font-mono text-[13px] leading-relaxed">{children}</code>
    }
    return (
      <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[12px] text-foreground/90">
        {children}
      </code>
    )
  },
  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-400 underline decoration-sky-400/50 underline-offset-2 hover:text-sky-300"
      >
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return (
      <th className="border border-border/60 bg-muted/40 px-3 py-1.5 text-left font-semibold text-foreground/90">
        {children}
      </th>
    )
  },
  td({ children }) {
    return <td className="border border-border/60 px-3 py-1.5">{children}</td>
  },
  ul({ children }) {
    return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground">
        {children}
      </blockquote>
    )
  },
  hr() {
    return <hr className="my-3 border-border/60" />
  },
  h1({ children }) {
    return <h1 className="my-2 text-lg font-bold">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="my-2 text-base font-bold">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="my-2 text-sm font-bold">{children}</h3>
  },
  h4({ children }) {
    return <h4 className="my-1.5 text-sm font-semibold">{children}</h4>
  },
}

export function Markdown({ text }: { text: string }) {
  if (!text) return null
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
