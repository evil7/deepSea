import { type LucideIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

// ---------------------------------------------------------------------------
// ComingSoonSlide —— 首页「规划中」板块（社区动态 / 深海套装）
// 杂志化排版：眉题编号 + 左侧大标题列 + 右侧能力规划卡片网格
// 占位期间展示规划能力；接入真实内容后替换 node 即可
// ---------------------------------------------------------------------------

interface PlannedItem {
  id: string
  icon: LucideIcon
  title: string
  description: string
  tag?: string
}

interface ComingSoonSlideProps {
  /** 眉题：章节编号 + 英文名（如 "04 · COMMUNITY"） */
  eyebrow: string
  /** 大标题 */
  title: string
  /** 副标题 */
  description: string
  /** 规划能力卡片 */
  items: PlannedItem[]
}

export function ComingSoonSlide({
  eyebrow,
  title,
  description,
  items,
}: ComingSoonSlideProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col justify-center px-4 py-16 sm:px-6">
      {/* 杂志化标题区：眉题 + 左对齐大标题 */}
      <div className="slide-reveal-title mb-10 max-w-2xl">
        <p className="font-mono text-xs tracking-[0.3em] text-cyan-300/90">
          {eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          {title}
        </h2>
        <p className="mt-3 text-white/65">{description}</p>
      </div>

      {/* 规划能力卡片网格 */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <Card
            key={item.id}
            className="slide-reveal-item border-white/15 bg-slate-900/70 text-white backdrop-blur-sm transition-colors hover:border-primary/50"
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <item.icon className="size-5" />
                </span>
                {item.tag && (
                  <Badge
                    variant="secondary"
                    className="border-white/10 bg-white/10 font-mono text-white/80"
                  >
                    {item.tag}
                  </Badge>
                )}
              </div>
              <CardTitle className="mt-4 text-white">{item.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-white/65">
                {item.description}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 占位标识 */}
      <p className="mt-8 flex items-center gap-2 text-xs text-white/40">
        <span className="size-1.5 rounded-full bg-cyan-400/70" />
        该板块规划中，即将上线
      </p>
    </div>
  )
}
