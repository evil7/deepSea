// ---------------------------------------------------------------------------
// extractThemeColors —— 从图片像素自动提取 3 个主题色（autoColor 核心算法）
//
// 需求约束（对应社区配色自适应）：
//   1. 先量化到「基础 16 色桶」（12 彩色色相桶 + 4 灰阶桶）
//   2. 权重管理偏向彩色：饱和度加权 × 明度中段三角，压低黑/白/大面积低饱和背景
//   3. 选举三色：色相分散优先（避免三色全撞同一色系），不足则用明度变体兜底
//
// 纯函数、无 DOM 依赖，可单测。
// ---------------------------------------------------------------------------

export interface ThemeColors {
  /** 主色：最鲜艳/代表色，用于徽章、分类色条、按钮、hover 边框 */
  primary: string
  /** 次色：与主色对比或同系浅变体，用于背景点阵渐变 */
  secondary: string
  /** 点缀色：第三色，用于评论徽章、进度、强调 */
  accent: string
}

/** 彩色桶数量（色相每 30° 一桶，共 12 桶） */
const HUE_BUCKETS = 12
/** 灰阶桶数量（黑/深灰/灰/白） */
const GRAY_BUCKETS = 4
/** 判定彩色/灰阶的饱和度阈值 */
const SAT_THRESHOLD = 0.12
/** 选举时要求两色相的最小间隔（桶数，2 桶 = 60°） */
const MIN_HUE_DIST = 2
/** 主色饱和度增强目标（原图偏灰，提升到 0.6 让主色更「彩色」） */
const TARGET_SATURATION = 0.6

interface Bucket {
  count: number
  weight: number
  r: number
  g: number
  b: number
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const mx = Math.max(rn, gn, bn)
  const mn = Math.min(rn, gn, bn)
  const d = mx - mn
  let h = 0
  if (d > 0) {
    if (mx === rn) h = 60 * (((gn - bn) / d) % 6)
    else if (mx === gn) h = 60 * ((bn - rn) / d + 2)
    else h = 60 * ((rn - gn) / d + 4)
  }
  if (h < 0) h += 360
  const s = mx === 0 ? 0 : d / mx
  const v = mx
  return [h, s, v]
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ]
}

/** 0~255 转两位十六进制（RGB 单通道） */
function hexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0")
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`
}

/** 饱和度增强：把颜色 HSV 的 S 提升到 target（保持 H/V） */
function saturate(r: number, g: number, b: number, target: number): string {
  const [h, s, v] = rgbToHsv(r, g, b)
  const [nr, ng, nb] = hsvToRgb(h, Math.max(s, target), v)
  return rgbToHex(nr, ng, nb)
}

/** 混白提亮（amt 0~1） */
function lighten(r: number, g: number, b: number, amt: number): string {
  return rgbToHex(
    r + (255 - r) * amt,
    g + (255 - g) * amt,
    b + (255 - b) * amt
  )
}

/** 混黑压暗（amt 0~1） */
function darken(r: number, g: number, b: number, amt: number): string {
  return rgbToHex(r * (1 - amt), g * (1 - amt), b * (1 - amt))
}

/** 色相桶环形距离（0~6 桶，6 = 对角） */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % HUE_BUCKETS
  return Math.min(d, HUE_BUCKETS - d)
}

/** 桶内加权平均色（空桶回退中灰） */
function bucketAvg(b: Bucket): [number, number, number] {
  return b.weight > 0
    ? [b.r / b.weight, b.g / b.weight, b.b / b.weight]
    : [128, 128, 128]
}

/**
 * 从 RGBA 像素数据提取主题色。
 * @param data  `ImageData.data`（Uint8ClampedArray，RGBA 顺序）
 * @param width  像素宽
 * @param height 像素高
 */
export function extractThemeColors(
  data: Uint8ClampedArray,
  width: number,
  height: number
): ThemeColors {
  const colorBuckets: Bucket[] = Array.from({ length: HUE_BUCKETS }, () => ({
    count: 0,
    weight: 0,
    r: 0,
    g: 0,
    b: 0,
  }))
  const grayBuckets: Bucket[] = Array.from({ length: GRAY_BUCKETS }, () => ({
    count: 0,
    weight: 0,
    r: 0,
    g: 0,
    b: 0,
  }))

  const total = width * height
  for (let i = 0; i < total; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    const a = data[i * 4 + 3]
    if (a < 128) continue // 透明像素跳过
    const [h, s, v] = rgbToHsv(r, g, b)
    // 权重：饱和度（彩色优先）× 明度中段三角（V≈0.5 最高，压黑白/深背景）
    const weight = s * (1 - Math.abs(v - 0.5) * 2)
    if (s >= SAT_THRESHOLD) {
      const idx = Math.floor(h / (360 / HUE_BUCKETS)) % HUE_BUCKETS
      const bucket = colorBuckets[idx]
      bucket.count++
      bucket.weight += weight
      bucket.r += r * weight
      bucket.g += g * weight
      bucket.b += b * weight
    } else {
      const idx =
        v < 0.2 ? 0 : v < 0.45 ? 1 : v < 0.75 ? 2 : 3
      grayBuckets[idx].count++
      grayBuckets[idx].weight += weight
    }
  }

  // 彩色桶按权重降序（toSorted 不修改原数组；Object.assign 避免 map 展开拷贝）
  const ranked = colorBuckets
    .map((bucket, i) => Object.assign({ i }, bucket))
    .filter((bucket) => bucket.count > 0)
    .toSorted((a, b) => b.weight - a.weight)

  // 兜底：无任何彩色桶 → 用明度中段灰
  if (ranked.length === 0) {
    const mid =
      grayBuckets[2].count > 0 ? grayBuckets[2] : grayBuckets[1]
    const [r, g, b] = bucketAvg(mid)
    return {
      primary: rgbToHex(r, g, b),
      secondary: lighten(r, g, b, 0.25),
      accent: darken(r, g, b, 0.25),
    }
  }

  // primary = 得分最高（最鲜艳）彩色桶，饱和度增强
  const pBucket = ranked[0]
  const [pr, pg, pb] = bucketAvg(pBucket)
  const primary = saturate(pr, pg, pb, TARGET_SATURATION)

  // secondary = 与 primary 色相分散（>=2 桶）的得分最高彩色桶
  const sCandidate = ranked.find(
    (b) => hueDist(b.i, pBucket.i) >= MIN_HUE_DIST
  )
  let secondary: string
  let accent: string
  if (sCandidate) {
    const [sr, sg, sb] = bucketAvg(sCandidate)
    secondary = saturate(sr, sg, sb, TARGET_SATURATION)
    // accent = 剩余彩色桶中得分最高，且与 primary/secondary 都尽量分散
    const aCandidate = ranked.find(
      (b) =>
        b.i !== pBucket.i &&
        b.i !== sCandidate.i &&
        hueDist(b.i, pBucket.i) >= 1 &&
        hueDist(b.i, sCandidate.i) >= 1
    )
    if (aCandidate) {
      const [ar, ag, ab] = bucketAvg(aCandidate)
      accent = saturate(ar, ag, ab, TARGET_SATURATION)
    } else {
      // 无第三对比色 → 用 primary 深变体
      accent = darken(pr, pg, pb, 0.3)
    }
  } else {
    // 图整体同色系（如纯蓝鲸）：secondary = 浅变体，accent = 深变体
    secondary = lighten(pr, pg, pb, 0.3)
    accent = darken(pr, pg, pb, 0.3)
  }

  return { primary, secondary, accent }
}
