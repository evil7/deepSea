// ---------------------------------------------------------------------------
// 讨论交流 discussions（前端 octokit 直调 GitHub API）
//   · 主社区 = evil7/deepSea（自有仓库，可互动：回复 / 表情 / 发帖）
//   · 匿名：读静态种子 public/data/discussions.json（Actions 每小时同步，
//     GitHub GraphQL 匿名 403，故用种子零配额读取）
//   · 登录：octokit GraphQL 直调（列表 / 详情 / 回复 / 表情 / 创建），
//     token 由 /auth/me 返回并经 useAuth 注入 client（不经过 Worker 代理）
//   · 排序：热门（评论数）/ 最新（updatedAt）本地完成
// ---------------------------------------------------------------------------

import { githubGraphQL, getToken } from "@/lib/github/client"

/** 主社区（自有仓库，可互动） */
export const COMMUNITY_OWNER = "evil7"
export const COMMUNITY_REPO = "deepSea"

/** 官方社区（deepseek-ai，只读） */
export const OFFICIAL_OWNER = "deepseek-ai"
export const OFFICIAL_REPO = "deepseek-harness"

export const DISCUSSIONS_SEED_URL = "/data/discussions.json"
export const OFFICIAL_DISCUSSIONS_SEED_URL = "/data/discussions-official.json"

/**
 * 社区来源标识（URL 路径段 `/community/{source}` 取值）：
 *   · dsh = 蓝鲸社区（官方 deepseek-ai/deepseek-harness，只读）
 *   · dpc = 浪尖酒馆（我们 evil7/deepSea，可互动，默认）
 */
export type CommunitySource = "dsh" | "dpc"

/** 单个社区的配置（owner/repo/名称/简介/发帖入口/对侧社区） */
export interface CommunityInfo {
  source: CommunitySource
  owner: string
  repo: string
  /** 社区名称（页头标题） */
  label: string
  /** 社区简介（页头副标题） */
  description: string
  /** 发起讨论的 GitHub 跳转链接 */
  createUrl: string
  /** 对侧社区名称（用于「前往xxxx」按钮） */
  counterpartLabel: string
  /** 对侧社区 source（用于「前往xxxx」跳转） */
  counterpartSource: CommunitySource
}

/** 依据 source 解析社区配置（默认 dpc = 浪尖酒馆） */
export function resolveCommunity(
  source: string | null | undefined
): CommunityInfo {
  if (source === "dsh") {
    return {
      source: "dsh",
      owner: OFFICIAL_OWNER,
      repo: OFFICIAL_REPO,
      label: "蓝鲸社区",
      description: "DeepSeek Harness 官方讨论 · 内容实时同步。",
      // 是否可回复不再在此硬编码：详情页通过 GraphQL 探测每个 discussion 的
      // locked / state 动态判断（仅当管理员锁定或关闭该讨论时才显示只读）。
      createUrl: `https://github.com/${OFFICIAL_OWNER}/${OFFICIAL_REPO}/discussions/new`,
      counterpartLabel: "浪尖酒馆",
      counterpartSource: "dpc",
    }
  }
  return {
    source: "dpc",
    owner: COMMUNITY_OWNER,
    repo: COMMUNITY_REPO,
    label: "浪尖酒馆",
    description: "深海的自家酒馆，畅聊插件、Q&A 与创意 · 回复与表态都从这里开始。",
    createUrl: `https://github.com/${COMMUNITY_OWNER}/${COMMUNITY_REPO}/discussions/new`,
    counterpartLabel: "蓝鲸社区",
    counterpartSource: "dsh",
  }
}

/** 依据 source 选择列表 seed 加载器 */
export function resolveSeedLoader(source: string | null | undefined): () => Promise<
  DiscussionSummary[]
> {
  return source === "dsh" ? loadOfficialDiscussionsSeed : loadDiscussionsSeed
}

/** 依据 source 选择登录态实时列表加载器 */
export function resolveLiveLoader(source: string | null | undefined): () => Promise<
  DiscussionSummary[] | null
> {
  return source === "dsh" ? loadOfficialDiscussionsLive : loadDiscussionsLive
}

/** GitHub ReactionContent 枚举值（支持的表情类型） */
export const REACTION_CONTENTS = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
] as const

export type ReactionContent = (typeof REACTION_CONTENTS)[number]

/** ReactionContent → emoji 映射（GitHub 官方表情） */
export const REACTION_EMOJI: Record<string, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
}

/** 表情反应（归一化后） */
export interface ReactionGroup {
  content: string
  count: number
  viewerHasReacted: boolean
}

/** GraphQL 原始 reactionGroup 结构 */
interface RawReactionGroup {
  content: string
  users: { totalCount: number }
  viewerHasReacted: boolean
}

/** 归一化 reactionGroups（过滤 count=0） */
function mapReactions(groups?: RawReactionGroup[] | null): ReactionGroup[] {
  return (groups ?? [])
    .filter((g) => g.users.totalCount > 0)
    .map((g) => ({
      content: g.content,
      count: g.users.totalCount,
      viewerHasReacted: g.viewerHasReacted,
    }))
}

/** 讨论详情（前端 octokit GraphQL 直调，需登录） */
export interface DiscussionDetail {
  /** 讨论节点 id（供回复 / 表情反应使用） */
  id: string
  number: number
  title: string
  body: string
  url: string
  categoryName: string
  author: string
  /** 发起者头像（可能为空 → 渲染时用 fallback，避免空 src） */
  authorAvatarUrl?: string
  createdAt: string
  updatedAt: string
  /** 是否被管理员锁定（锁定后无法回复 / 表态） */
  locked: boolean
  /** 是否已关闭（关闭后无法回复） */
  closed: boolean
  /** 投票数（upvote） */
  upvoteCount: number
  /** 发起人的其他帖子（不含当前帖，最多 10 条） */
  authorPosts: AuthorPost[]
  /** 评论总数（含嵌套回复；列表可能因 first 截断而少于总数） */
  commentTotalCount: number
  /** 讨论主体的表情反应 */
  reactions: ReactionGroup[]
  comments: DiscussionComment[]
}

/** 发起人的其他帖子（边栏「发起人的其他帖子」卡片，最多 10 条） */
export interface AuthorPost {
  number: number
  title: string
  url: string
}

/** 评论（含表情反应与回复树字段） */
export interface DiscussionComment {
  id: string
  author: string
  /** 评论者头像（可能为空 → 渲染时用 fallback） */
  avatarUrl?: string
  body: string
  createdAt: string
  /** 是否被标记为答案（管理员采纳） */
  isAnswer: boolean
  /** 评论投票数 */
  upvoteCount: number
  /** 被回复的父评论 node id（null = 顶层评论） */
  replyToId: string | null
  /** 被回复的父评论作者 login（用于「回复 @xxx」引用，null = 顶层） */
  replyToAuthor: string | null
  reactions: ReactionGroup[]
}

export interface DiscussionSummary {
  number: number
  title: string
  url: string
  categoryName: string
  /** 评论数（热门排序依据） */
  comments: number
  /** 参与人数（发帖者 + 评论作者去重；旧 seed 可能缺失 → 可选，渲染时兜底） */
  participants?: number
  author: string
  /** 发起者头像（seed 可能没有 → 可选，渲染时用 fallback） */
  avatarUrl?: string
  createdAt: string
  updatedAt: string
}

/** 讨论分类（主社区 evil7/deepSea 实际的 6 个 category） */
export const DISCUSSION_CATEGORIES = [
  "Announcements",
  "General",
  "Ideas",
  "Q&A",
  "Show and tell",
  "Polls",
] as const

/** 分类（含节点 id，供创建讨论时选择） */
export interface DiscussionCategory {
  id: string
  name: string
}

let seedCache: DiscussionSummary[] | null = null
let seedLoading: Promise<DiscussionSummary[]> | null = null

/** 订阅者：数据刷新后触发（登录用户由前端 worker 每 3 分钟同步最新列表） */
type Listener = () => void
const listeners = new Set<Listener>()

/** 订阅数据变化（返回取消函数） */
export function subscribeDiscussions(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 用最新列表替换内存缓存并通知订阅者（未加载前仅缓存，等待首次加载） */
export function setDiscussionsCache(list: DiscussionSummary[]): void {
  seedCache = list
  seedLoading = null
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      // 订阅者异常不影响其余通知
    }
  }
}

/** 当前内存缓存（未加载返回 null；供前端 worker 判断是否需要推送） */
export function getDiscussionsCache(): DiscussionSummary[] | null {
  return seedCache
}

/** 加载 discussions 种子（内存缓存；失败返回空数组，不抛错） */
export function loadDiscussionsSeed(): Promise<DiscussionSummary[]> {
  if (seedCache) {
    return Promise.resolve(seedCache)
  }
  if (!seedLoading) {
    seedLoading = fetch(DISCUSSIONS_SEED_URL)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`seed ${res.status}`)
        }
        return res.json()
      })
      .then((data: DiscussionSummary[]) => {
        seedCache = Array.isArray(data) ? data : []
        return seedCache
      })
      .catch(() => {
        seedCache = []
        return []
      })
  }
  return seedLoading
}

let officialSeedCache: DiscussionSummary[] | null = null
let officialSeedLoading: Promise<DiscussionSummary[]> | null = null

/** 加载官方社区 discussions 种子（内存缓存；失败返回空数组，不抛错） */
export function loadOfficialDiscussionsSeed(): Promise<DiscussionSummary[]> {
  if (officialSeedCache) {
    return Promise.resolve(officialSeedCache)
  }
  if (!officialSeedLoading) {
    officialSeedLoading = fetch(OFFICIAL_DISCUSSIONS_SEED_URL)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`official seed ${res.status}`)
        }
        return res.json()
      })
      .then((data: DiscussionSummary[]) => {
        officialSeedCache = Array.isArray(data) ? data : []
        return officialSeedCache
      })
      .catch(() => {
        officialSeedCache = []
        return []
      })
  }
  return officialSeedLoading
}

/** 从讨论列表推导分类名（去重，保持首次出现顺序）；用于匿名 fallback 分类分区 */
export function deriveCategories(list: DiscussionSummary[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of list) {
    if (d.categoryName && !seen.has(d.categoryName)) {
      seen.add(d.categoryName)
      out.push(d.categoryName)
    }
  }
  return out
}

/** 最新：按 updatedAt 倒序 */
export function sortDiscussionsLatest(
  list: DiscussionSummary[]
): DiscussionSummary[] {
  return [...list].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 热门：按评论数倒序（同评论数按更新时间） */
export function sortDiscussionsHot(
  list: DiscussionSummary[]
): DiscussionSummary[] {
  return [...list].toSorted(
    (a, b) => b.comments - a.comments || b.updatedAt.localeCompare(a.updatedAt)
  )
}

/** 参与人数：发帖者 + 评论作者去重（评论作者可能为空，发帖者恒计入） */
export function countParticipants(
  author: string,
  commentAuthors: string[]
): number {
  const set = new Set(commentAuthors)
  set.add(author)
  return set.size
}

/** 相对时间（如 "3 分钟前"、"2 小时前"、"5 天前"） */
export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) {
    return ""
  }
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) {
    return "刚刚"
  }
  if (min < 60) {
    return `${min} 分钟前`
  }
  const hr = Math.floor(min / 60)
  if (hr < 24) {
    return `${hr} 小时前`
  }
  const day = Math.floor(hr / 24)
  if (day < 30) {
    return `${day} 天前`
  }
  return iso.slice(0, 10)
}

// ---------------------------------------------------------------------------
// 以下为前端 octokit GraphQL 直调（登录后带 token；未登录调用返回 null）
// ---------------------------------------------------------------------------

/** 判断当前是否已注入 token（登录态） */
export function hasToken(): boolean {
  return getToken() !== null
}

/** 查询主社区讨论分类（id + name），供创建讨论选择 */
export async function loadDiscussionCategories(): Promise<
  DiscussionCategory[]
> {
  try {
    const data = await githubGraphQL<{
      repository?: {
        discussionCategories?: { nodes?: { id: string; name: string }[] }
      } | null
    }>(
      `query ($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          discussionCategories(first: 20) { nodes { id name } }
        }
      }`,
      { owner: COMMUNITY_OWNER, repo: COMMUNITY_REPO }
    )
    return data.repository?.discussionCategories?.nodes ?? []
  } catch {
    return []
  }
}

/** 通用：登录后实时拉取某仓库 discussions 列表（octokit GraphQL 直调） */
async function fetchDiscussionsLive(
  owner: string,
  repo: string,
  first: number
): Promise<DiscussionSummary[] | null> {
  try {
    const data = await githubGraphQL<{
      repository?: {
        discussions?: {
          nodes?: {
            number: number
            title: string
            url: string
            category: { name: string }
            comments: {
              totalCount: number
              nodes?: { author: { login: string } }[]
            }
            author: { login: string; avatarUrl: string }
            createdAt: string
            updatedAt: string
          }[]
        } | null
      } | null
    }>(
      `query ($owner: String!, $repo: String!, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          discussions(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes {
              number title url
              category { name }
              comments(first: 100) {
                totalCount
                nodes { author { login } }
              }
              author { login avatarUrl }
              createdAt updatedAt
            }
          }
        }
      }`,
      { owner, repo, first }
    )
    const nodes = data.repository?.discussions?.nodes
    if (!nodes) return null
    return nodes.map((d) => ({
      number: d.number,
      title: d.title,
      url: d.url,
      categoryName: d.category.name,
      comments: d.comments.totalCount,
      participants: countParticipants(
        d.author.login,
        (d.comments.nodes ?? []).map((c) => c.author.login)
      ),
      author: d.author.login,
      avatarUrl: d.author.avatarUrl,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))
  } catch {
    return null
  }
}

/** 登录后实时拉取主社区讨论列表（octokit 直调，替换 seed 缓存） */
export function loadDiscussionsLive(): Promise<DiscussionSummary[] | null> {
  return fetchDiscussionsLive(COMMUNITY_OWNER, COMMUNITY_REPO, 50)
}

/** 登录后实时拉取官方社区讨论列表（octokit 直调，只读） */
export function loadOfficialDiscussionsLive(): Promise<
  DiscussionSummary[] | null
> {
  return fetchDiscussionsLive(OFFICIAL_OWNER, OFFICIAL_REPO, 50)
}

/**
 * 通用：加载某仓库讨论详情（前端 octokit GraphQL 直调，需登录）。
 * 未登录/失败返回 null，不抛错。
 */
async function fetchDiscussionDetail(
  owner: string,
  repo: string,
  number: number
): Promise<DiscussionDetail | null> {
  try {
    const data = await githubGraphQL<{
      repository?: {
        id: string
        discussion?: {
          id: string
          number: number
          title: string
          body: string
          url: string
          locked: boolean
          closed: boolean
          upvoteCount: number
          category: { name: string }
          author: { login: string; avatarUrl: string }
          createdAt: string
          updatedAt: string
          reactionGroups?: RawReactionGroup[]
          comments: {
            totalCount: number
            nodes: {
              id: string
              author: { login: string; avatarUrl: string }
              body: string
              createdAt: string
              isAnswer: boolean
              upvoteCount: number
              replyTo?: { id: string; author: { login: string } } | null
              reactionGroups?: RawReactionGroup[]
            }[]
          }
        } | null
      } | null
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          id
          discussion(number: $number) {
            id number title body url locked closed upvoteCount
            category { name }
            author { login avatarUrl }
            createdAt updatedAt
            reactionGroups { content users { totalCount } viewerHasReacted }
            comments(first: 100) {
              totalCount
              nodes {
                id
                author { login avatarUrl }
                body createdAt
                isAnswer upvoteCount
                replyTo { id author { login } }
                reactionGroups { content users { totalCount } viewerHasReacted }
              }
            }
          }
        }
      }`,
      { owner, repo, number }
    )
    const repoNode = data.repository
    const d = repoNode?.discussion
    if (!d || !repoNode) return null
    // 发起人的其他帖子（排除当前帖，最多 10 条；失败降级为空数组）
    const authorPosts = await fetchAuthorPosts(
      d.author.login,
      repoNode.id,
      number
    )
    return {
      id: d.id,
      number: d.number,
      title: d.title,
      body: d.body,
      url: d.url,
      categoryName: d.category.name,
      author: d.author.login,
      authorAvatarUrl: d.author.avatarUrl,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      locked: d.locked,
      closed: d.closed,
      upvoteCount: d.upvoteCount,
      authorPosts,
      commentTotalCount: d.comments.totalCount,
      reactions: mapReactions(d.reactionGroups),
      comments: (d.comments.nodes ?? []).map((c) => ({
        id: c.id,
        author: c.author.login,
        avatarUrl: c.author.avatarUrl,
        body: c.body,
        createdAt: c.createdAt,
        isAnswer: c.isAnswer,
        upvoteCount: c.upvoteCount,
        replyToId: c.replyTo?.id ?? null,
        replyToAuthor: c.replyTo?.author?.login ?? null,
        reactions: mapReactions(c.reactionGroups),
      })),
    }
  } catch {
    return null
  }
}

/**
 * 查询发起人的其他帖子（User.repositoryDiscussions，按仓库过滤）。
 * 排除当前讨论本身，最多返回 10 条（按最近更新倒序）。
 * 失败返回空数组（不抛错；边栏仅在非空时展示该卡片）。
 */
async function fetchAuthorPosts(
  login: string,
  repositoryId: string,
  excludeNumber: number
): Promise<AuthorPost[]> {
  try {
    const data = await githubGraphQL<{
      user?: {
        repositoryDiscussions?: {
          nodes?: { number: number; title: string; url: string }[]
        } | null
      } | null
    }>(
      `query ($login: String!, $repositoryId: ID!, $first: Int!) {
        user(login: $login) {
          repositoryDiscussions(
            first: $first
            repositoryId: $repositoryId
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes { number title url }
          }
        }
      }`,
      { login, repositoryId, first: 11 }
    )
    return (data.user?.repositoryDiscussions?.nodes ?? [])
      .filter((p) => p.number !== excludeNumber)
      .slice(0, 10)
      .map((p) => ({ number: p.number, title: p.title, url: p.url }))
  } catch {
    return []
  }
}

/** 加载我们的社区讨论详情（evil7/deepSea） */
export function loadDiscussionDetail(
  number: number
): Promise<DiscussionDetail | null> {
  return fetchDiscussionDetail(COMMUNITY_OWNER, COMMUNITY_REPO, number)
}

/** 加载官方社区讨论详情（deepseek-ai/deepseek-harness，只读） */
export function loadOfficialDiscussionDetail(
  number: number
): Promise<DiscussionDetail | null> {
  return fetchDiscussionDetail(OFFICIAL_OWNER, OFFICIAL_REPO, number)
}

/**
 * 发表回复（前端 octokit addDiscussionComment mutation，需登录）。
 * 成功返回 comment；失败 comment=null + failure 分类（不抛错）。
 */
export async function postDiscussionComment(
  _number: number,
  discussionId: string,
  body: string
): Promise<{ comment: DiscussionComment | null; failure?: WriteFailure }> {
  try {
    const data = await githubGraphQL<{
      addDiscussionComment?: {
        comment?: {
          id: string
          author: { login: string; avatarUrl: string }
          body: string
          createdAt: string
          reactionGroups?: RawReactionGroup[]
        } | null
      } | null
    }>(
      `mutation ($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
          comment {
            id
            author { login avatarUrl }
            body createdAt
            reactionGroups { content users { totalCount } viewerHasReacted }
          }
        }
      }`,
      { discussionId, body }
    )
    const c = data.addDiscussionComment?.comment
    if (!c) return { comment: null }
    return {
      comment: {
        id: c.id,
        author: c.author.login,
        avatarUrl: c.author.avatarUrl,
        body: c.body,
        createdAt: c.createdAt,
        // 新发布的评论恒为顶层、非答案、零票
        isAnswer: false,
        upvoteCount: 0,
        replyToId: null,
        replyToAuthor: null,
        reactions: mapReactions(c.reactionGroups),
      },
    }
  } catch (err) {
    return { comment: null, failure: classifyWriteError(err) }
  }
}

/** 写操作失败原因分类（供 UI 针对性提示） */
export type WriteFailureKind = "forbidden" | "rate_limited" | "unknown"

export interface WriteFailure {
  kind: WriteFailureKind
  /** 原始错误信息（调试用，非必须展示） */
  message?: string
}

/** 将捕获的异常归类为可展示的失败原因（识别权限不足 / 限流 / 其它） */
function classifyWriteError(err: unknown): WriteFailure {
  const e = err as {
    message?: string
    errors?: Array<{ type?: string; message?: string }>
  }
  const parts: string[] = []
  if (e.errors) {
    for (const gqlErr of e.errors) {
      parts.push(gqlErr.type ?? "", gqlErr.message ?? "")
    }
  }
  if (e.message) parts.push(e.message)
  const full = parts.join(" ")

  // 权限不足：组织 OAuth App 访问限制 / 无写权限
  if (
    /FORBIDDEN/i.test(full) ||
    /access restrictions/i.test(full) ||
    /third-parties is limited/i.test(full) ||
    /required permissions/i.test(full)
  ) {
    return { kind: "forbidden", message: e.message }
  }
  // 限流（含 secondary rate limit / abuse detection）
  if (/rate limit|abuse detection/i.test(full)) {
    return { kind: "rate_limited", message: e.message }
  }
  return { kind: "unknown", message: e.message }
}

/**
 * 切换表情反应（前端 octokit addReaction / removeReaction，需登录）。
 * active=true 添加，false 移除。成功 ok=true；失败 ok=false + failure 分类。
 */
export async function toggleReaction(
  subjectId: string,
  content: string,
  active: boolean
): Promise<{ ok: boolean; failure?: WriteFailure }> {
  try {
    const mutation = active
      ? `mutation ($subjectId: ID!, $content: ReactionContent!) {
          addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
        }`
      : `mutation ($subjectId: ID!, $content: ReactionContent!) {
          removeReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
        }`
    await githubGraphQL(mutation, { subjectId, content })
    return { ok: true }
  } catch (err) {
    return { ok: false, failure: classifyWriteError(err) }
  }
}

/**
 * 创建讨论（前端 octokit createDiscussion mutation，需登录）。
 * 成功返回 { number, url }，失败返回 null。
 */
export async function createDiscussion(params: {
  categoryId: string
  title: string
  body: string
}): Promise<{ number: number; url: string } | null> {
  try {
    // 先取仓库 node id
    const repoData = await githubGraphQL<{
      repository?: { id?: string } | null
    }>(
      `query ($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) { id }
      }`,
      { owner: COMMUNITY_OWNER, repo: COMMUNITY_REPO }
    )
    const repositoryId = repoData.repository?.id
    if (!repositoryId) return null

    const data = await githubGraphQL<{
      createDiscussion?: {
        discussion?: { number: number; url: string } | null
      } | null
    }>(
      `mutation ($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
        createDiscussion(input: {
          repositoryId: $repositoryId
          categoryId: $categoryId
          title: $title
          body: $body
        }) {
          discussion { number url }
        }
      }`,
      {
        repositoryId,
        categoryId: params.categoryId,
        title: params.title,
        body: params.body,
      }
    )
    const d = data.createDiscussion?.discussion
    if (!d) return null
    return { number: d.number, url: d.url }
  } catch {
    return null
  }
}
