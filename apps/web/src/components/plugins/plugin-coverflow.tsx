import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react"
import { animate } from "animejs"
import { Layers, Star } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"

import type { PluginRepo } from "@/lib/github/types"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// PluginFanDeck —— 插件精选「码牌叠放」画廊（animejs，仅用于展示/落地页）
//   · 卡片错位叠放并铺满容器宽度：第一张贴最左、最后一张贴最右，
//     步进随容器宽度自适应（ResizeObserver 测量），不堆积在一侧
//   · 每张卡带固定随机姿态：合理范围的随机旋转 + 上下偏移
//     （确定性种子，如随手丢在桌上的牌，姿态稳定不随渲染/切换变化）
//   · 总牌数 10：前 9 张真实插件卡 + 第 10 张「more」背面卡（扑克牌花纹）
//   · 交互：整容器 hover，鼠标横向位置决定抽出哪张卡；点击容器跳转
//     （真实卡 → 插件详情，more → 全部插件）；无 hover 自动顺序循环播放
//   · 切换（热门/最新）：所有卡在原位 180° 翻转（animejs rotateY）完成切换
//   · 自动播放进度：当前卡外框 conic 渐变发光推进（原下方 tabs 已移除）
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
/** 底部留白（px）：原 tabs 已移除，仅作底部呼吸空间 */
const BOTTOM_SPACE = 34
/** 无 hover 时自动顺序循环播放间隔（ms） */
const AUTO_PLAY_INTERVAL = 2800
/** 切换（热门/最新）翻转动画时长（ms） */
const FLIP_DURATION = 560
/** 翻转时相邻牌之间的错峰间隔（ms） */
const FLIP_STEP = 55
const DURATION = 420
const EASING = "easeOutExpo"
const FLIP_EASING = "easeInOutCubic"

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
  const { t } = useTranslation()
  const navigate = useNavigate()
  // 传入的最新数据（只取前 9 张真实卡）
  const incomingRepos = repos.slice(0, REAL_CARD_COUNT)
  // 实际渲染的数据：翻转中点才切到新数据，避免文字在翻转中跳闪
  const [shownRepos, setShownRepos] = useState(incomingRepos)
  // 翻转进行中：卡片内容渲染 Skeleton 占位（shadcn）
  const [flipping, setFlipping] = useState(false)
  const [active, setActive] = useState(0)
  // hover 状态：hover 中由鼠标横向位置控制；离开容器自动顺序循环播放
  const [hovered, setHovered] = useState(false)
  // 自动播放进度（0~1）：当前卡外框渐变发光推进，与切换间隔同步
  const [progress, setProgress] = useState(0)
  const progressRef = useRef(0)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  // more 背面卡 ref
  const backCardRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 记录当前 active（供自动播放时比对，避免多余 setState）
  const activeRef = useRef(active)
  const hoveredRef = useRef(hovered)
  // 数据切换（热门/最新）翻转动画进行中标记（期间忽略 hover）
  const flippingRef = useRef(false)
  // 翻转中点/结束 timer（独立于 effect cleanup，避免 signature 变化误清）
  const flipMidTimerRef = useRef(0)
  const flipEndTimerRef = useRef(0)
  // 上一轮传入数据的 signature：检测数据切换
  const prevIncomingRef = useRef("")
  // 是否已完成首次布局（首帧直接定位，不触发翻转）
  const initializedRef = useRef(false)
  // 容器实际宽度（ResizeObserver 测量；决定码牌铺满步进）
  const [containerW, setContainerW] = useState(0)

  // 渲染用数据（翻转期间仍为旧数据，配合 Skeleton 占位）
  const displayRepos = shownRepos
  const signature = displayRepos.map((r) => r.full_name).join("|")
  const incomingSignature = incomingRepos.map((r) => r.full_name).join("|")

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    hoveredRef.current = hovered
  }, [hovered])

  // 数据切换（热门/最新）：翻转一圈，中点切换数据（期间卡片内容为 Skeleton）
  useEffect(() => {
    // 首次挂载 / 布局未就绪：直接同步数据，不翻转
    if (!initializedRef.current || containerW === 0) {
      if (incomingSignature !== signature) {
        setShownRepos(incomingRepos)
      }
      prevIncomingRef.current = incomingSignature
      return
    }
    if (incomingSignature === prevIncomingRef.current) {
      return
    }
    prevIncomingRef.current = incomingSignature
    if (incomingSignature === signature) {
      return
    }

    // 清理上一次未结束的 timer（连续快速切换时避免旧 timer 干扰）
    window.clearTimeout(flipMidTimerRef.current)
    window.clearTimeout(flipEndTimerRef.current)

    flippingRef.current = true
    setFlipping(true)
    setActive(0)
    activeRef.current = 0

    const totalCount = displayRepos.length + 1
    const flipOne = (el: HTMLElement, index: number) => {
      animate(el, {
        rotateY: [0, 360],
        duration: FLIP_DURATION,
        delay: index * FLIP_STEP,
        ease: FLIP_EASING,
      })
    }
    for (let i = 0; i < displayRepos.length; i++) {
      const card = cardRefs.current[i]
      if (card) {
        flipOne(card, i)
      }
    }
    const back = backCardRef.current
    if (back) {
      flipOne(back, displayRepos.length)
    }

    // 翻转中点（180°）切换数据 → 后半段展示新数据
    // 注意：timer 不放 effect cleanup——setShownRepos 会让 signature 变化触发
    // effect 重跑，若 cleanup 清掉 endTimer 则 setFlipping(false) 永不执行。
    flipMidTimerRef.current = window.setTimeout(() => {
      setShownRepos(incomingRepos)
    }, FLIP_DURATION / 2)

    // 翻转结束，恢复真实内容（此时已切换到新数据）
    flipEndTimerRef.current = window.setTimeout(() => {
      flippingRef.current = false
      setFlipping(false)
    }, FLIP_DURATION + totalCount * FLIP_STEP)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingSignature, signature, containerW])

  // 组件卸载时清理翻转 timer
  useEffect(() => {
    return () => {
      window.clearTimeout(flipMidTimerRef.current)
      window.clearTimeout(flipEndTimerRef.current)
    }
  }, [])

  // 无 hover → 自动顺序循环播放真实卡（more 卡不参与）；
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
        goTo((activeRef.current + 1) % displayRepos.length)
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

  // 布局：首帧直接定位（无闪烁）；active 抽出/回叠用 animejs 过渡
  useEffect(() => {
    if (containerW === 0 || displayRepos.length === 0) {
      return
    }
    // more 背面卡也参与堆叠：总牌数 = 真实卡 + 1 = 10，一起按步进铺满容器
    const totalCount = displayRepos.length + 1
    const first = !initializedRef.current
    for (let i = 0; i < displayRepos.length; i++) {
      const s = deckState(i, active, totalCount, containerW)
      const card = cardRefs.current[i]
      if (!card) {
        continue
      }
      if (first) {
        card.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`
        card.style.opacity = String(s.opacity)
        card.style.zIndex = String(s.zIndex)
      } else {
        // active 抽出/回叠：先把 z-index 立即落定，再播放位置过渡
        card.style.zIndex = String(s.zIndex)
        animate(card, {
          translateX: s.x,
          translateY: s.y,
          scale: s.scale,
          opacity: s.opacity,
          duration: DURATION,
          ease: EASING,
        })
      }
    }
    // more 背面卡布局（active === more 时同样抽出）
    const back = backCardRef.current
    if (back) {
      const bs = deckState(totalCount - 1, active, totalCount, containerW)
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
          ease: EASING,
        })
      }
    }
    initializedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, displayRepos.length, containerW])

  const moreIndex = displayRepos.length

  const goTo = (i: number) => {
    // active 范围 0..moreIndex（0..moreIndex-1 真实卡，moreIndex = more 背面卡）
    const n = Math.max(0, Math.min(i, moreIndex))
    if (n !== activeRef.current) {
      setActive(n)
    }
  }

  /** 整容器 hover：按鼠标横向位置映射到对应卡（含 more），驱动抽出 */
  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (flippingRef.current) {
      return
    }
    const el = containerRef.current
    if (!el) {
      return
    }
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    goTo(Math.floor(ratio * (moreIndex + 1)))
  }

  /** 点击容器：跳转当前 active 卡（真实卡 → 详情，more → 全部） */
  const handleClick = () => {
    if (flippingRef.current) {
      return
    }
    const i = activeRef.current
    if (i === moreIndex) {
      navigate("/plugins")
      return
    }
    const repo = displayRepos[i]
    if (repo) {
      const [owner, name] = repo.full_name.split("/")
      navigate(`/plugin/${owner}/${name}`)
    }
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t("plugins.galleryLabel")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      className="relative w-full cursor-pointer"
      style={{
        height: TOP_SPACE + CARD_H + BOTTOM_SPACE,
        perspective: 1200,
      }}
    >
      {/* 卡片层：错位叠放铺满宽度，animejs 控制 transform（交互走整容器 hover/点击） */}
      {displayRepos.map((repo, i) => {
        const isActive = i === active
        // key 用 index 是有意的：cardRefs 按 index 存 ref，key 必须与 index
        // 对应才能保证 ref 映射正确（no-array-index-key 豁免）
        /* eslint-disable react/no-array-index-key */
        return (
          <div
            key={`card-${i}`}
            ref={(el) => {
              cardRefs.current[i] = el
            }}
            role="presentation"
            aria-label={t("plugins.cardLabel", { name: repo.full_name, index: i + 1 })}
            className="absolute top-11 left-0 block will-change-transform"
            style={{
              width: CARD_W,
              height: CARD_H,
              transformStyle: "preserve-3d",
            }}
          >
            {/* 内层：固定随机姿态（旋转 + 上下偏移），静态不参与动画，
                避免 animejs 对 rotate 的解析/累加问题（角度翻倍） */}
            <div
              className="relative h-full will-change-transform"
              style={(() => {
                const posture = cardPosture(i)
                return {
                  transform: `rotate(${posture.rotateZ}deg) translateY(${posture.y}px)`,
                  transformStyle: "preserve-3d",
                }
              })()}
            >
              {/* 自动播放进度：当前卡外框 conic 渐变发光推进（替代原 tabs 进度条） */}
              {isActive && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-0.75 rounded-[18px]"
                  style={
                    {
                      background: `conic-gradient(from -90deg, rgba(34,211,238,0.9) ${Math.min(progress, 1) * 360}deg, transparent 0deg)`,
                      WebkitMask:
                        "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                      WebkitMaskComposite: "xor",
                      mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                      maskComposite: "exclude",
                      padding: "2.5px",
                    } as CSSProperties
                  }
                />
              )}
              <div
                className={cn(
                  "flex h-full flex-col rounded-2xl border p-5 shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop-blur-sm transition-colors",
                  isActive
                    ? "border-cyan-400/40 bg-slate-900/95"
                    : "border-white/12 bg-slate-900/70"
                )}
                style={{ backfaceVisibility: "hidden" }}
              >
                {flipping ? (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <Skeleton className="size-11 rounded-xl bg-white/10" />
                      <Skeleton className="h-5 w-14 rounded-full bg-white/10" />
                    </div>
                    <Skeleton className="mt-4 h-5 w-3/4 bg-white/10" />
                    <Skeleton className="mt-2 h-3.5 w-full bg-white/10" />
                    <Skeleton className="mt-1.5 h-3.5 w-5/6 bg-white/10" />
                    <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
                      <Skeleton className="h-4 w-16 bg-white/10" />
                      <Skeleton className="h-5 w-12 rounded-md bg-white/10" />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 font-mono text-lg font-bold text-cyan-300">
                        {i + 1}
                      </div>
                      {repo.is_official && (
                        <Badge
                          variant="outline"
                          className="border-amber-400/40 bg-amber-400/10 text-amber-300"
                        >
                          {t("common.official")}
                        </Badge>
                      )}
                    </div>

                    <h3 className="mt-4 line-clamp-1 font-mono text-base font-semibold text-white">
                      {repo.full_name}
                    </h3>
                    <p className="mt-2 line-clamp-3 flex-1 text-xs leading-relaxed text-white/60">
                      {repo.description || t("common.noDescription")}
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
                  </>
                )}
              </div>
            </div>
          </div>
        )
        /* eslint-enable react/no-array-index-key */
      })}

      {/* 第 10 张 more 背面卡：扑克牌背面（CSS 矢量花纹平铺），作为牌堆最后一张
          正常参与堆叠；active === moreIndex 时抽出（由整容器 hover/点击控制） */}
      {containerW > 0 && (
        <div
          ref={backCardRef}
          role="presentation"
          aria-label={t("plugins.morePlugins")}
          className="absolute top-11 left-0 block will-change-transform"
          style={{
            width: CARD_W,
            height: CARD_H,
            transformStyle: "preserve-3d",
          }}
        >
          {/* 内层：静态 -3° 微旋（more 卡姿态） */}
          <div
            className="relative h-full overflow-hidden rounded-2xl border border-cyan-400/25 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
            style={{
              transform: "rotate(-3deg)",
              transformStyle: "preserve-3d",
              backfaceVisibility: "hidden",
            }}
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
    </div>
  )
}
