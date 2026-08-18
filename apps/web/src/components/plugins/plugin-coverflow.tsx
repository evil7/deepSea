import { useEffect, useRef, useState } from "react"
import { animate } from "animejs"
import { Layers, Star } from "lucide-react"
import { Link } from "react-router-dom"

import type { PluginRepo } from "@/lib/github/types"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// PluginFanDeck —— 插件精选「码牌叠放」画廊（animejs，仅用于展示/落地页）
//   · 卡片错位叠放并铺满容器宽度：第一张贴最左、最后一张贴最右，
//     步进随容器宽度自适应（ResizeObserver 测量），不堆积在一侧
//   · 每张卡带固定随机姿态：合理范围的随机旋转 + 上下偏移
//     （确定性种子，如随手丢在桌上的牌，姿态稳定不随渲染/切换变化）
//   · 总牌数 10：前 9 张真实插件卡 + 第 10 张「more」背面卡（扑克牌花纹）
//   · 卡牌纯展示：hover 由下方 1-9 + more 的 tabs 控制（hover tab → 对应卡
//     抽出放大）；点击 tab 执行对应行为（1-9 跳插件详情、more 跳全部插件）
//   · 无 hover（鼠标离开）自动顺序循环播放前 9 张，回到容器即暂停
//   · 切换动画：先把新卡立即提升到首位（z-index 置顶），再同时播放
//     新卡放大 / 原卡缩小（animejs 过渡）
//   · 叠放卡保持不透明（码牌层次由层叠/阴影表达）
// ---------------------------------------------------------------------------

/** 卡片尺寸（标准扑克牌比例 2.5:3.5 ≈ 1:1.4） */
const CARD_W = 250
const CARD_H = 350
/** 真实插件卡数量（1-9） */
const REAL_CARD_COUNT = 9
/** 抽出上移距离（负数 = 向上抽出，叠加在卡片自身随机偏移上） */
const RAISE_Y = -26
/** 抽出放大倍率 */
const RAISE_SCALE = 1.1
/** 随机旋转范围（±3°，像随手丢桌上的牌） */
const ROTATE_RANGE = 6
/** 随机上下偏移范围（±12px） */
const Y_RANGE = 24
/** 容器两侧留白（px） */
const DECK_PADDING = 8
/** 顶部预留空间（px）：抽出卡上移+放大后不越界覆盖上方标题区 */
const TOP_SPACE = 44
/** 底部 tabs 区高度（px）：卡牌贴近 tabs */
const TABS_SPACE = 34
/** 无 hover 时自动顺序循环播放间隔（ms） */
const AUTO_PLAY_INTERVAL = 2800
const DURATION = 420
const EASING = "easeOutExpo"

interface DeckState {
  x: number
  y: number
  scale: number
  opacity: number
  zIndex: number
}

/** 码牌步进：让第一张贴左、最后一张贴右 → 铺满容器宽度不堆积一侧 */
function calcStep(count: number, containerW: number): number {
  return count > 1
    ? Math.max(40, (containerW - CARD_W - DECK_PADDING * 2) / (count - 1))
    : 0
}

/** 确定性伪随机（基于 seed，保证每张卡姿态稳定不随渲染变化） */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** 每张卡的固定随机姿态（旋转 + 上下偏移，如随机丢在桌上的牌） */
function cardPosture(i: number): { rotateZ: number; y: number } {
  return {
    rotateZ: (seededRandom(i + 1) - 0.5) * ROTATE_RANGE,
    y: (seededRandom(i + 101) - 0.5) * Y_RANGE,
  }
}

/** 码牌叠放布局：第 i 张卡外层目标状态（active 抽出，其余叠放铺满宽度） */
function deckState(
  i: number,
  active: number,
  count: number,
  containerW: number
): DeckState {
  const isActive = i === active
  const step = calcStep(count, containerW)
  return {
    x: i * step + DECK_PADDING,
    // 抽出：外层再上移（随机上下偏移由内层静态姿态负责，不与动画混叠）
    y: isActive ? RAISE_Y : 0,
    scale: isActive ? RAISE_SCALE : 0.92,
    // 叠放卡不透明（码牌层次由层叠/阴影表达）
    opacity: 1,
    zIndex: isActive ? 1000 : i + 1,
  }
}

function formatStars(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return String(n)
}

export function PluginFanDeck({ repos }: { repos: PluginRepo[] }) {
  // 只展示前 9 张真实卡（1-9）+ more 背面卡 = 共 10 张
  const displayRepos = repos.slice(0, REAL_CARD_COUNT)
  const [active, setActive] = useState(0)
  // hover 状态：hover 中由鼠标控制；离开容器自动顺序循环播放
  const [hovered, setHovered] = useState(false)
  // 自动播放进度（0~1）：active tab 上从左往右的背景填充，与切换间隔同步，
  // 表示距下次自动切换的进度（内部切换进度指示）
  const [progress, setProgress] = useState(0)
  const progressRef = useRef(0)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  // more 背面卡 ref
  const backCardRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 记录当前 active（供自动播放时比对，避免多余 setState）
  const activeRef = useRef(active)
  const hoveredRef = useRef(hovered)
  // 记录上一轮布局（用于无闪烁首帧 + 动画 from 态）
  const layoutRef = useRef({ signature: "", states: [] as DeckState[] })
  // 容器实际宽度（ResizeObserver 测量；决定码牌铺满步进）
  const [containerW, setContainerW] = useState(0)

  const signature = displayRepos.map((r) => r.full_name).join("|")

  // 数据源变化（热门/最新切换）→ 回到第一张
  useEffect(() => {
    setActive(0)
  }, [signature])

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    hoveredRef.current = hovered
  }, [hovered])

  // 无 hover → 自动顺序循环播放前 9 张（more 卡不参与自动循环）；
  // 同时推进 progress（0→1 与 AUTO_PLAY_INTERVAL 同步），到 1 即切换并归零
  useEffect(() => {
    if (hovered || displayRepos.length === 0) {
      return
    }
    progressRef.current = 0
    setProgress(0)
    const stepMs = 50 // 进度刷新粒度（~20fps，开销极低）
    const timer = setInterval(() => {
      progressRef.current += stepMs / AUTO_PLAY_INTERVAL
      if (progressRef.current >= 1) {
        progressRef.current = 0
        goTo((activeRef.current + 1) % REAL_CARD_COUNT)
      }
      setProgress(progressRef.current)
    }, stepMs)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, displayRepos.length, signature])

  // 监听容器宽度变化（窗口缩放/布局变化 → 重新铺满）
  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerW(entry.contentRect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 布局：首帧直接定位（无闪烁）；之后 animejs 过渡（抽出/回叠）
  useEffect(() => {
    if (containerW === 0 || displayRepos.length === 0) {
      return
    }
    // more 背面卡也参与堆叠：总牌数 = 真实卡 + 1 = 10，一起按步进铺满容器
    const totalCount = displayRepos.length + 1
    const prev = layoutRef.current
    const first = prev.signature !== signature
    const states: DeckState[] = []
    for (let i = 0; i < displayRepos.length; i++) {
      const s = deckState(i, active, totalCount, containerW)
      states.push(s)
      const card = cardRefs.current[i]
      if (!card) {
        continue
      }
      if (first) {
        card.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`
        card.style.opacity = String(s.opacity)
        card.style.zIndex = String(s.zIndex)
      } else {
        // 切换动画：先把所有卡 z-index 立即落定（新卡瞬间置顶到首位），
        // 再同时播放新卡放大 / 原卡缩小（z-index 不参与动画插值）
        card.style.zIndex = String(s.zIndex)
        animate(card, {
          translateX: s.x,
          translateY: s.y,
          scale: s.scale,
          opacity: s.opacity,
          duration: DURATION,
          easing: EASING,
        })
      }
    }
    // more 背面卡布局（active === 9 时同样抽出）
    const back = backCardRef.current
    if (back) {
      const bs = deckState(totalCount - 1, active, totalCount, containerW)
      states.push(bs)
      if (first) {
        back.style.transform = `translate(${bs.x}px, ${bs.y}px) scale(${bs.scale})`
        back.style.zIndex = String(bs.zIndex)
      } else {
        back.style.zIndex = String(bs.zIndex)
        animate(back, {
          translateX: bs.x,
          translateY: bs.y,
          scale: bs.scale,
          duration: DURATION,
          easing: EASING,
        })
      }
    }
    layoutRef.current = { signature, states }
  }, [active, displayRepos, signature, containerW])

  const goTo = (i: number) => {
    // active 范围 0..9（0-8 真实卡，9 = more 背面卡）
    const n = Math.max(0, Math.min(i, REAL_CARD_COUNT))
    if (n !== activeRef.current) {
      setActive(n)
    }
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="插件精选画廊"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative w-full cursor-pointer"
      style={{
        height: TOP_SPACE + CARD_H + TABS_SPACE,
        perspective: 1200,
      }}
    >
      {/* 卡片层：错位叠放铺满宽度，animejs 控制 transform（纯展示，交互走 tabs） */}
      {displayRepos.map((repo, i) => {
        const isActive = i === active
        return (
          <div
            key={repo.full_name}
            ref={(el) => {
              cardRefs.current[i] = el
            }}
            role="presentation"
            aria-label={`${repo.full_name}，插件卡 ${i + 1}`}
            className="absolute top-[44px] left-0 block will-change-transform"
            style={{ width: CARD_W, height: CARD_H }}
          >
            {/* 内层：固定随机姿态（旋转 + 上下偏移），静态不参与动画，
                避免 animejs 对 rotate 的解析/累加问题（角度翻倍） */}
            <div
              className="h-full will-change-transform"
              style={(() => {
                const posture = cardPosture(i)
                return {
                  transform: `rotate(${posture.rotateZ}deg) translateY(${posture.y}px)`,
                }
              })()}
            >
              <div
                className={cn(
                  "flex h-full flex-col rounded-2xl border p-5 shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop-blur-sm transition-colors",
                  isActive
                    ? "border-cyan-400/40 bg-slate-900/95"
                    : "border-white/12 bg-slate-900/70"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 font-mono text-lg font-bold text-cyan-300">
                    {i + 1}
                  </div>
                  {repo.is_official && (
                    <Badge
                      variant="outline"
                      className="border-amber-400/40 bg-amber-400/10 text-amber-300"
                    >
                      官方
                    </Badge>
                  )}
                </div>

                <h3 className="mt-4 line-clamp-1 font-mono text-base font-semibold text-white">
                  {repo.full_name}
                </h3>
                <p className="mt-2 line-clamp-3 flex-1 text-xs leading-relaxed text-white/60">
                  {repo.description || "暂无描述"}
                </p>

                <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
                  <span className="flex items-center gap-1 text-sm text-white/80">
                    <Star className="size-4 text-amber-300" />
                    {formatStars(repo.stargazers_count)}
                  </span>
                  <span className="rounded-md border border-white/10 px-2 py-0.5 font-mono text-[11px] text-white/50">
                    {repo.language ?? "?"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )
      })}

      {/* 第 10 张 more 背面卡：扑克牌背面（CSS 矢量花纹平铺），作为牌堆最后一张
          正常参与堆叠；active === 9 时抽出（由 tabs 的 more 控制），纯展示 */}
      {containerW > 0 && (
        <div
          ref={backCardRef}
          role="presentation"
          aria-label="更多插件（浏览全部）"
          className="absolute top-[44px] left-0 block will-change-transform"
          style={{ width: CARD_W, height: CARD_H }}
        >
          {/* 内层：静态 -3° 微旋（more 卡姿态） */}
          <div
            className="relative h-full overflow-hidden rounded-2xl border border-cyan-400/25 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
            style={{ transform: "rotate(-3deg)" }}
          >
            {/* 扑克牌背面花纹：斜向编织交叉平铺（无限拼接）+ 细网格 */}
            <div
              className="absolute inset-0"
              style={{
                backgroundColor: "#0b3a52",
                backgroundImage: [
                  "repeating-linear-gradient(45deg, rgba(8,36,52,0.9) 0 12px, rgba(12,74,104,0.9) 12px 24px)",
                  "repeating-linear-gradient(-45deg, rgba(12,74,104,0.9) 0 12px, rgba(8,36,52,0.9) 12px 24px)",
                  "linear-gradient(rgba(103,232,249,0.12) 1px, transparent 1px)",
                  "linear-gradient(90deg, rgba(103,232,249,0.12) 1px, transparent 1px)",
                ].join(", "),
                backgroundSize: "24px 24px, 24px 24px, 48px 48px, 48px 48px",
              }}
            />
            {/* 内框装饰（扑克背经典双线内框） */}
            <div className="absolute inset-2.5 rounded-xl border border-cyan-300/25" />
            <div className="absolute inset-4 rounded-lg border border-cyan-300/15" />
            {/* 中央图案 */}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <span className="flex size-12 items-center justify-center rounded-full border border-cyan-300/40 bg-cyan-400/10">
                <Layers className="size-5 text-cyan-200" />
              </span>
              <span className="font-mono text-xs tracking-[0.2em] text-cyan-100">
                more
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 1-9 + more tabs：hover 控制卡片抽出；点击执行对应行为（跳详情 / 全部） */}
      <div
        className="absolute bottom-0 left-1/2 z-[1100] flex -translate-x-1/2 items-center gap-1.5"
        onMouseMove={(e) => e.stopPropagation()}
      >
        {displayRepos.map((repo, i) => {
          const [owner, name] = repo.full_name.split("/")
          const isActive = i === active
          return (
            <Link
              key={repo.full_name}
              to={`/plugin/${owner}/${name}`}
              onMouseEnter={() => goTo(i)}
              aria-label={`查看 ${repo.full_name}`}
              className={cn(
                "relative overflow-hidden rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                isActive
                  ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-200"
                  : "border-white/15 bg-slate-900/70 text-white/60 hover:border-cyan-400/40 hover:text-white"
              )}
            >
              {/* 自动播放进度填充：从左往右，跟随切换间隔（0→1） */}
              {isActive && (
                <span
                  className="absolute inset-y-0 left-0 bg-cyan-400/25 transition-[width] duration-75 ease-linear"
                  style={{ width: `${Math.min(progress, 1) * 100}%` }}
                />
              )}
              <span className="relative z-10">{i + 1}</span>
            </Link>
          )
        })}
        <Link
          to="/plugins"
          onMouseEnter={() => goTo(REAL_CARD_COUNT)}
          aria-label="浏览全部插件"
          className={cn(
            "relative overflow-hidden rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
            active === REAL_CARD_COUNT
              ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-200"
              : "border-white/15 bg-slate-900/70 text-white/60 hover:border-cyan-400/40 hover:text-white"
          )}
        >
          {/* 自动播放进度填充（active 为 more 时也显示，但自动循环不进入 more） */}
          {active === REAL_CARD_COUNT && (
            <span
              className="absolute inset-y-0 left-0 bg-cyan-400/25 transition-[width] duration-75 ease-linear"
              style={{ width: `${Math.min(progress, 1) * 100}%` }}
            />
          )}
          <span className="relative z-10">more</span>
        </Link>
      </div>
    </div>
  )
}
