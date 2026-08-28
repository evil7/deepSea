// ---------------------------------------------------------------------------
// community-blocks —— 社区软屏蔽判定（纯函数层，无存储）
//
//   · 存储/同步见 lib/user-preferences.ts（localStorage + D1 跟随账号）
//   · 两类规则：
//       1. 屏蔽用户：blockedUsers 命中作者
//       2. 低质过滤：THUMBS_DOWN ≥ thumbsDownThreshold（临时开关可覆盖）
//   · 处理模式三态：
//       collapse —— 折叠（帖子标记 + 降序 + "低质贴" label；评论/回复折叠条）
//       hide     —— 隐藏（列表主动过滤；评论/回复不渲染）
//       off      —— 不处理
//   · 临时开关（低质屏蔽 on|off）：会话级覆盖，不持久化；null = 跟随个人设置
// ---------------------------------------------------------------------------

export type BlockMode = "collapse" | "hide" | "off"

/** 软屏蔽偏好（存储层在此之上叠加 language/theme） */
export interface CommunityBlocks {
  /** 屏蔽的用户 login 列表（软屏蔽，仅过滤展示） */
  blockedUsers: string[]
  /** 低质阈值：THUMBS_DOWN ≥ 该值时应用过滤；0 = 关闭低质规则 */
  thumbsDownThreshold: number
  /** 命中规则后的处理模式 */
  mode: BlockMode
}

export const DEFAULT_BLOCKS: CommunityBlocks = {
  blockedUsers: [],
  thumbsDownThreshold: 0,
  mode: "collapse",
}

/** 同页广播事件（偏好/临时开关变更通知） */
export const BLOCKS_CHANGED_EVENT = "deepsea:blocks-changed"

// ---------------------------------------------------------------------------
// 临时开关（低质屏蔽 on|off）：会话级覆盖，不持久化
//   null = 跟随个人设置（mode!==off 且阈值>0）
//   true / false = 临时覆盖
// ---------------------------------------------------------------------------

let lowQualityOverride: boolean | null = null

export function getLowQualityOverride(): boolean | null {
  return lowQualityOverride
}

/** 设置临时开关（null 复位为跟随设置）；广播同页 hook */
export function setLowQualityOverride(value: boolean | null): void {
  lowQualityOverride = value
  window.dispatchEvent(new CustomEvent(BLOCKS_CHANGED_EVENT))
}

/**
 * 低质过滤是否生效（临时开关优先；默认跟随个人设置）。
 * 仅当模式非 off 且阈值 > 0 时低质规则才可能命中。
 */
export function isLowQualityEnabled(blocks: CommunityBlocks): boolean {
  const base = blocks.mode !== "off" && blocks.thumbsDownThreshold > 0
  return lowQualityOverride ?? base
}

/** 是否命中「用户屏蔽」（大小写不敏感比较 login；off 模式不处理） */
export function isUserBlocked(
  blocks: CommunityBlocks,
  author: string | null | undefined
): boolean {
  if (blocks.mode === "off") return false
  if (!author || blocks.blockedUsers.length === 0) return false
  const target = author.toLowerCase()
  return blocks.blockedUsers.some((u) => u.toLowerCase() === target)
}

/** 从 reactions 中取 THUMBS_DOWN 计数（无则 0） */
export function thumbsDownCount(
  reactions: { content: string; count: number }[] | undefined
): number {
  if (!reactions) return 0
  return reactions.find((r) => r.content === "THUMBS_DOWN")?.count ?? 0
}

/**
 * 是否命中「低质过滤」：低质开关生效 + 阈值开启 + THUMBS_DOWN ≥ 阈值。
 * 返回 true 时内容应被隐藏 / 折叠。
 */
export function isThumbsDownBlocked(
  blocks: CommunityBlocks,
  reactions: { content: string; count: number }[] | undefined
): boolean {
  if (!isLowQualityEnabled(blocks)) return false
  return thumbsDownCount(reactions) >= blocks.thumbsDownThreshold
}

/** 帖子是否低质（列表页用 summary.thumbsDown 判定） */
export function isLowQualitySummary(
  blocks: CommunityBlocks,
  thumbsDown: number | undefined
): boolean {
  if (!isLowQualityEnabled(blocks)) return false
  return (thumbsDown ?? 0) >= blocks.thumbsDownThreshold
}

export type BlockReason = "user" | "thumbs_down"

/**
 * 综合判定一条内容是否应被软屏蔽（用户屏蔽 或 低质过滤）。
 * 返回 null 表示不屏蔽；否则返回命中原因（供折叠条提示）。
 */
export function resolveBlockReason(
  blocks: CommunityBlocks,
  input: { author?: string | null; reactions?: { content: string; count: number }[] }
): BlockReason | null {
  if (isUserBlocked(blocks, input.author)) return "user"
  if (isThumbsDownBlocked(blocks, input.reactions)) return "thumbs_down"
  return null
}

/** 追加屏蔽用户（去重、trim；返回新列表） */
export function addBlockedUser(
  blocks: CommunityBlocks,
  login: string
): CommunityBlocks {
  const clean = login.trim().replace(/^@/, "")
  if (!clean) return blocks
  if (blocks.blockedUsers.some((u) => u.toLowerCase() === clean.toLowerCase())) {
    return blocks
  }
  return { ...blocks, blockedUsers: [...blocks.blockedUsers, clean] }
}

/** 移除屏蔽用户 */
export function removeBlockedUser(
  blocks: CommunityBlocks,
  login: string
): CommunityBlocks {
  return {
    ...blocks,
    blockedUsers: blocks.blockedUsers.filter(
      (u) => u.toLowerCase() !== login.toLowerCase()
    ),
  }
}
