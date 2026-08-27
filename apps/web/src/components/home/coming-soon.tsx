import { type LucideIcon } from "lucide-react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// ComingSoonSlide —— 首页「规划中」板块（社区动态 / 深海套装）
// 杂志化排版：眉题编号 + 左侧大标题列 + 右侧能力规划卡片网格
// 占位期间展示规划能力；接入真实内容后替换 node 即可
//
// 卡片两种形态：
//   · 已上线（href 有值）：可点击跳转，右上角「已上线」徽章，无 coming soon 遮罩
//   · 规划中（href 无值）：hover 后虚化背景 + 浮现「COMING SOON」遮罩
// ---------------------------------------------------------------------------

interface PlannedItem {
  id: string
  icon: LucideIcon
  title: string
  description: string
  tag?: string
  /** 已上线：提供站内跳转链接；有值时卡片可点击且不显示 coming soon 遮罩 */
  href?: string
}

/** 遮罩右半区域的漂浮粒子（复用社区纸屑的白/浅蓝配色）。 */
interface ParticleSpec {
  left: number
  top: number
  size: number
  delay: number
  duration: number
  /** 亮度衰减系数（0→1）：靠右越亮，向左递减到中间归零（与遮罩渐变同步）。 */
  amp: number
  bright: boolean
}

/**
 * 固定粒子布局（模块加载一次，位置/节奏确定，所有 coming soon 卡片共用）。
 * 右密左疏：left 用 sqrt 偏置向右聚拢（50%~98%），amp 线性 0→1 向左衰减。
 */
const PARTICLES: ParticleSpec[] = Array.from({ length: 20 }, (_, i) => {
  const t = (i + 0.5) / 20
  const skew = Math.sqrt(t)
  return {
    left: 50 + skew * 48,
    top: 5 + ((i * 53) % 88),
    size: 1.5 + skew * 3.5,
    delay: (i % 6) * 0.5,
    duration: 3 + (i % 4) * 0.8,
    amp: t,
    bright: i % 2 === 0,
  }
})

/** 右半渐变遮罩内的漂浮粒子层（右密左疏，复用社区纸屑配色）。 */
function MaskParticles() {
  return (
    <div className="absolute inset-0" aria-hidden="true">
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className="absolute"
          style={{ left: `${p.left}%`, top: `${p.top}%`, opacity: p.amp }}
        >
          <span
            className="coming-soon-particle"
            style={{
              width: p.size,
              height: p.size,
              background: p.bright
                ? "rgba(255,255,255,0.8)"
                : "rgba(186,230,253,0.6)",
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
            }}
          />
        </span>
      ))}
    </div>
  )
}

interface ComingSoonSlideProps {
  /** 眉题：章节编号 + 英文名（如 "03 · COMMUNITY"） */
  eyebrow: string
  /** 大标题 */
  title: string
  /** 副标题 */
  description: string
  /** 规划能力卡片 */
  items: PlannedItem[]
  /** 安装命令提示（可选）：锚点 id + 标签 + 命令，如 deepc 工具安装 */
  installHint?: {
    id: string
    label: string
    command: string
  }
}

export function ComingSoonSlide({
  eyebrow,
  title,
  description,
  items,
  installHint,
}: ComingSoonSlideProps) {
  const { t } = useTranslation()
  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col justify-center px-4 py-16 sm:px-6">
      {/* 杂志化标题区：眉题 + 左对齐大标题 */}
      <div className="slide-reveal-title mb-10 max-w-2xl">
        <p className="font-mono text-xs tracking-[0.3em] text-cyan-300/90">
          {eyebrow}
        </p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          {title}
        </h2>
        <p className="mt-3 text-white/65">{description}</p>
      </div>

      {/* 规划能力卡片网格：固定两列（四张卡分两行） */}
      <div className="grid gap-6 sm:grid-cols-2">
        {items.map((item) =>
          item.href ? (
            // 已上线卡片：可点击跳转，无 coming soon 遮罩
            <Link
              key={item.id}
              to={item.href}
              className="slide-reveal-item coming-soon-live-card group relative block"
            >
              <Card className="h-full border-white/15 bg-slate-900/70 text-white backdrop-blur-sm transition-colors group-hover:border-primary/60">
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <item.icon className="size-5" />
                      </span>
                      <CardTitle className="truncate text-white">
                        {item.title}
                      </CardTitle>
                    </div>
                    <Badge
                      variant="secondary"
                      className="shrink-0 border-emerald-400/30 bg-emerald-400/10 font-mono text-emerald-300"
                    >
                      {t("comingSoon.launched")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-relaxed text-white/65">
                    {item.description}
                  </p>
                </CardContent>
              </Card>
              {/* 遮罩：hover 显示 START + 弹跳箭头（复用右半渐变 + 粒子） */}
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-xl",
                  "opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                )}
              >
                <div className="absolute inset-0 bg-linear-to-l from-slate-950/85 via-slate-950/45 to-transparent" />
                <MaskParticles />
                <div className="absolute inset-y-0 right-0 flex flex-col items-end justify-center gap-3 pr-7">
                  <span className="coming-soon-start">START</span>
                  <span className="coming-soon-bounce-arrow" aria-hidden="true">
                    →
                  </span>
                </div>
              </div>
            </Link>
          ) : (
            // 规划中卡片：hover 后虚化 + COMING/SOON 对角飞入遮罩
            <div key={item.id} className="slide-reveal-item coming-soon-card group relative">
              <Card className="h-full border-white/15 bg-slate-900/70 text-white backdrop-blur-sm transition-colors">
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <item.icon className="size-5" />
                      </span>
                      <CardTitle className="truncate text-white">
                        {item.title}
                      </CardTitle>
                    </div>
                    {item.tag && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 border-white/10 bg-white/10 font-mono text-white/80"
                      >
                        {item.tag}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-relaxed text-white/65">
                    {item.description}
                  </p>
                </CardContent>
              </Card>
              {/* coming soon 遮罩：右半渐变虚化 + 粒子 + 双词右侧划入 */}
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-xl",
                  "opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                )}
              >
                {/* 渐变遮罩：右浓左淡，只虚化右半 */}
                <div className="absolute inset-0 bg-linear-to-l from-slate-950/85 via-slate-950/45 to-transparent" />
                {/* 漂浮粒子层（右半区域，右密左疏递减到中间） */}
                <MaskParticles />
                {/* 文字：右对齐两排，从右划入（COMING 先、SOON 后） */}
                <div className="absolute inset-y-0 right-0 flex flex-col items-end justify-center gap-2 pr-7">
                  <span className="coming-soon-word coming-soon-word--coming">
                    COMING
                  </span>
                  <span className="coming-soon-word coming-soon-word--soon">
                    SOON
                  </span>
                </div>
              </div>
            </div>
          )
        )}
      </div>

      {/* 安装命令提示（如 deepc 工具安装）：锚点 id 供导航滚动定位 */}
      {installHint && (
        <div
          id={installHint.id}
          className="mt-8 flex scroll-mt-24 items-center justify-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 px-4 py-2.5 backdrop-blur-sm"
        >
          <span className="text-xs text-white/50">{installHint.label}：</span>
          <code className="rounded bg-black/40 px-2 py-0.5 font-mono text-xs text-cyan-300">
            {installHint.command}
          </code>
        </div>
      )}

      {/* 占位标识 */}
      <p className="mt-8 flex items-center gap-2 text-xs text-white/40">
        <span className="size-1.5 rounded-full bg-cyan-400/70" />
        {t("comingSoon.planning")}
      </p>
    </div>
  )
}
