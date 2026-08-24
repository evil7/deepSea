// ---------------------------------------------------------------------------
// Sidebar —— chatUI 左栏（复刻官方）：品牌行 + 新建会话 + 工作区搜索/会话树 +
// 底部【设置 + 连接状态】。自管理搜索 / 视图排列 / 折叠等局部状态。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Archive,
  ChevronRight,
  Folder,
  GitBranch,
  ListOrdered,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ConnectStatus } from "@/components/link/connect-status"
import { cn } from "@/lib/utils"
import type { ClientState } from "@/lib/deepc-link/client"
import type { HelloFrame, SessionSummary, WorkspaceView } from "@/lib/deepc-link/protocol"

/** 会话视图排列偏好（对齐官方 EngineStore 的 groupBy/orderBy，本地持久化）。 */
interface ViewSort {
  groupBy: "workspace" | "flat"
  orderBy: "manual" | "updated"
}

const VIEW_SORT_KEY = "deepsea:sidebar:viewSort"
const DEFAULT_VIEW_SORT: ViewSort = { groupBy: "workspace", orderBy: "manual" }

function readViewSort(): ViewSort {
  try {
    const raw = localStorage.getItem(VIEW_SORT_KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<ViewSort>
      return { groupBy: v.groupBy ?? "workspace", orderBy: v.orderBy ?? "manual" }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_VIEW_SORT
}

function writeViewSort(v: ViewSort): void {
  try {
    localStorage.setItem(VIEW_SORT_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

export interface SidebarProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  hostInfo: HelloFrame["host"] | null
  workspaces: WorkspaceView[]
  sessions: SessionSummary[]
  archivedSessionIds: Set<string>
  activeSessionId: string | null
  state: ClientState
  elapsed: number
  onSelectSession: (id: string) => void
  onCreateSession: (cwd?: string) => void
  onAddWorkspace: () => void
  onRenameWorkspace: (id: string, title: string) => void
  onDeleteWorkspace: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onForkSession: (id: string) => void
  onArchiveSession: (id: string) => void
  onOpenSettings: () => void
  onDisconnect: () => void
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  hostInfo,
  workspaces,
  sessions,
  archivedSessionIds,
  activeSessionId,
  state,
  elapsed,
  onSelectSession,
  onCreateSession,
  onAddWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onRenameSession,
  onForkSession,
  onArchiveSession,
  onOpenSettings,
  onDisconnect,
}: SidebarProps) {
  const [searchActive, setSearchActive] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [viewSort, setViewSort] = useState<ViewSort>(() => readViewSort())
  const [viewSortOpen, setViewSortOpen] = useState(false)
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set())
  const [wsMenuId, setWsMenuId] = useState<string | null>(null)
  const viewSortRef = useRef<HTMLDivElement | null>(null)

  // 点击视图选项外部时收起下拉。
  useEffect(() => {
    if (!viewSortOpen) return
    const onDown = (e: MouseEvent) => {
      if (viewSortRef.current && !viewSortRef.current.contains(e.target as Node)) {
        setViewSortOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [viewSortOpen])

  const toggleWorkspace = useCallback((workspaceId: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId)

  // 按搜索词过滤工作区会话。
  const keyword = searchQuery.trim().toLowerCase()
  const filteredWorkspaces = useMemo(() => {
    if (!keyword) return workspaces
    return workspaces
      .map((ws) => ({
        ...ws,
        sessionIds: ws.sessionIds.filter((id) => {
          const s = sessions.find((x) => x.sessionId === id)
          if (!s) return false
          const dir = s.cwd ? s.cwd.split(/[\\/]/).pop() || "" : ""
          return dir.toLowerCase().includes(keyword)
        }),
      }))
      .filter((ws) => ws.sessionIds.length > 0)
  }, [workspaces, sessions, keyword])

  // 分组渲染时隐藏 blank + 归档会话（官方 sessionVisible 语义）。
  const visibleSessions = useCallback(
    (wsSessionIds: string[]) => {
      const list = wsSessionIds
        .map((id) => sessions.find((s) => s.sessionId === id))
        .filter((s): s is SessionSummary => Boolean(s))
        .filter((s) => !s.blank || s.sessionId === activeSessionId)
        .filter((s) => !archivedSessionIds.has(s.sessionId))
      if (viewSort.orderBy === "updated") {
        return list.toSorted((a, b) => b.updatedAt - a.updatedAt)
      }
      return list
    },
    [sessions, activeSessionId, archivedSessionIds, viewSort.orderBy]
  )

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border/60 bg-sidebar py-3 gap-1.5">
        <img src="/deepseek.svg" alt="" aria-hidden className="size-6 shrink-0 opacity-90 dark:invert" />
        <div className="mt-4 flex flex-col items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={() => onCreateSession(activeSession?.cwd ?? workspaces[0]?.path)}
            title="新建会话"
          >
            <MessageSquarePlus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={onAddWorkspace}
            title="添加工作区"
          >
            <Plus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={() => setSearchActive(true)}
            title="搜索会话"
          >
            <Search className="size-4" />
          </Button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="flex w-70 shrink-0 flex-col border-r border-border/60 bg-sidebar">
      {/* 品牌行 + 收起 */}
      <div className="flex h-15 shrink-0 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2 px-1">
          <img src="/deepseek.svg" alt="" aria-hidden className="size-5 shrink-0 opacity-90 dark:invert" />
          <span className="truncate text-sm font-semibold text-sidebar-foreground">
            {hostInfo?.hostname ?? "deepSea"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={onToggleCollapsed}
          title="收起侧栏"
        >
          <PanelLeft className="size-4" />
        </Button>
      </div>

      {/* 新建会话 */}
      <div className="shrink-0 px-3">
        <Button
          variant="secondary"
          className="flex w-full items-center justify-center gap-2"
          onClick={() => onCreateSession(activeSession?.cwd ?? workspaces[0]?.path)}
        >
          <MessageSquarePlus className="size-4" />
          新建会话
        </Button>
      </div>

      {/* 工作区：标签 + 搜索/视图选项/添加工作区 三按钮 */}
      <div className="mt-2 flex shrink-0 items-center gap-1 px-3">
        {searchActive ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索会话…"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              onClick={() => {
                setSearchActive(false)
                setSearchQuery("")
              }}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              title="关闭搜索"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">工作区</span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                onClick={() => setSearchActive(true)}
                title="搜索会话"
              >
                <Search className="size-4" />
              </Button>
              <div className="relative" ref={viewSortRef}>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-7 text-muted-foreground", viewSortOpen && "bg-muted/60")}
                  onClick={() => setViewSortOpen((v) => !v)}
                  title="视图选项"
                >
                  <ListOrdered className="size-4" />
                </Button>
                {viewSortOpen && (
                  <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
                    <ViewSortMenu
                      value={viewSort}
                      onChange={(v) => {
                        setViewSort(v)
                        writeViewSort(v)
                        setViewSortOpen(false)
                      }}
                    />
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                onClick={onAddWorkspace}
                title="添加工作区"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* 会话树 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {filteredWorkspaces.length === 0 && !keyword ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">暂无会话</p>
        ) : filteredWorkspaces.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">无匹配会话</p>
        ) : viewSort.groupBy === "flat" ? (
          (() => {
            const allIds = filteredWorkspaces.flatMap((ws) => ws.sessionIds)
            const flatSessions = visibleSessions(allIds)
            if (flatSessions.length === 0) {
              return <p className="px-2 py-6 text-center text-xs text-muted-foreground">无匹配会话</p>
            }
            return (
              <FlatSessionTree
                sessions={flatSessions}
                activeSessionId={activeSessionId}
                onSelect={onSelectSession}
                onRename={(id) => {
                  const s = sessions.find((x) => x.sessionId === id)
                  const next = window.prompt("重命名会话", s ? sessionTitle(s) : undefined)
                  if (next?.trim()) onRenameSession(id, next.trim())
                }}
                onFork={onForkSession}
                onArchive={onArchiveSession}
              />
            )
          })()
        ) : (
          filteredWorkspaces.map((ws) => {
            const wsSessions = visibleSessions(ws.sessionIds)
            return (
              <div key={ws.workspaceId} className="mb-1">
                <div className="group flex w-full items-center gap-1.5 rounded-lg text-sidebar-foreground transition-colors hover:bg-muted/60">
                  <button
                    type="button"
                    onClick={() => toggleWorkspace(ws.workspaceId)}
                    className="flex h-8.5 min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        !collapsedWorkspaces.has(ws.workspaceId) && "rotate-90"
                      )}
                    />
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{ws.title || ws.path}</span>
                  </button>
                  <div className="relative mr-1">
                    <button
                      type="button"
                      title="更多"
                      onClick={() => setWsMenuId(wsMenuId === ws.workspaceId ? null : ws.workspaceId)}
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-colors hover:bg-muted/60 hover:text-foreground group-hover:opacity-100",
                        wsMenuId === ws.workspaceId && "opacity-100 bg-muted/60"
                      )}
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                    {wsMenuId === ws.workspaceId && (
                      <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                          onClick={() => {
                            const next = window.prompt("重命名工作区", ws.title || ws.path)
                            if (next?.trim()) onRenameWorkspace(ws.workspaceId, next.trim())
                            setWsMenuId(null)
                          }}
                        >
                          <Pencil className="size-3.5" /> 重命名
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-rose-400 transition-colors hover:bg-muted/60"
                          onClick={() => {
                            if (window.confirm(`删除工作区「${ws.title || ws.path}」？`)) {
                              onDeleteWorkspace(ws.workspaceId)
                            }
                            setWsMenuId(null)
                          }}
                        >
                          <Trash2 className="size-3.5" /> 删除工作区
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {!collapsedWorkspaces.has(ws.workspaceId) &&
                  wsSessions.map((s) => (
                    <SessionRow
                      key={s.sessionId}
                      session={s}
                      active={activeSessionId === s.sessionId}
                      onSelect={onSelectSession}
                      onRename={(id) => {
                        const next = window.prompt("重命名会话", sessionTitle(s))
                        if (next?.trim()) onRenameSession(id, next.trim())
                      }}
                      onFork={onForkSession}
                      onArchive={onArchiveSession}
                    />
                  ))}
              </div>
            )
          })
        )}
      </div>

      {/* 底部：设置（为主）+ 极简连接状态（靠右） */}
      <div className="shrink-0 border-t border-border/60 p-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-sm text-muted-foreground"
            onClick={onOpenSettings}
          >
            <Settings className="size-4" />
            设置
          </Button>
          <div className="ml-auto shrink-0">
            <ConnectStatus state={state} elapsed={elapsed} onDisconnect={onDisconnect} />
          </div>
        </div>
      </div>
    </aside>
  )
}

/** 排列菜单的选项行。 */
function SortOption({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
        active ? "bg-muted/70 text-foreground" : "text-muted-foreground hover:bg-muted/40"
      )}
    >
      <span className="min-w-0 flex-1">{label}</span>
      {active && <span className="shrink-0 text-emerald-400">✓</span>}
    </button>
  )
}

/** 会话视图排列菜单（groupBy / orderBy）。 */
function ViewSortMenu({ value, onChange }: { value: ViewSort; onChange: (v: ViewSort) => void }) {
  return (
    <div className="space-y-0.5">
      <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        分组
      </p>
      <SortOption
        active={value.groupBy === "workspace"}
        label="按工作区"
        onClick={() => onChange({ ...value, groupBy: "workspace" })}
      />
      <SortOption
        active={value.groupBy === "flat"}
        label="扁平"
        onClick={() => onChange({ ...value, groupBy: "flat" })}
      />
      <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        排序
      </p>
      <SortOption
        active={value.orderBy === "manual"}
        label="手动"
        onClick={() => onChange({ ...value, orderBy: "manual" })}
      />
      <SortOption
        active={value.orderBy === "updated"}
        label="最近更新"
        onClick={() => onChange({ ...value, orderBy: "updated" })}
      />
    </div>
  )
}

/** 平铺会话树：所有会话跨工作区平铺显示（viewSort.groupBy==='flat'）。 */
function FlatSessionTree({
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onFork,
  onArchive,
}: {
  sessions: SessionSummary[]
  activeSessionId: string | null | undefined
  onSelect: (id: string) => void
  onRename?: (id: string) => void
  onFork?: (id: string) => void
  onArchive?: (id: string) => void
}) {
  if (sessions.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">无匹配会话</p>
  }
  return (
    <div className="mb-1">
      {sessions.map((s) => (
        <SessionRow
          key={s.sessionId}
          session={s}
          active={activeSessionId === s.sessionId}
          onSelect={onSelect}
          onRename={onRename}
          onFork={onFork}
          onArchive={onArchive}
        />
      ))}
    </div>
  )
}

/** 会话行（复刻官方）。 */
function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onFork,
  onArchive,
}: {
  session: SessionSummary
  active: boolean
  onSelect: (id: string) => void
  onRename?: (id: string) => void
  onFork?: (id: string) => void
  onArchive?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="group relative flex h-8 w-full items-center gap-1.5 rounded-lg pr-1 pl-7 text-left text-sm transition-colors hover:bg-muted/60">
      <button
        type="button"
        onClick={() => void onSelect(session.sessionId)}
        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className={cn("min-w-0 flex-1 truncate", active ? "text-foreground" : "text-foreground/80")}>
          {sessionTitle(session)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(session.updatedAt)}</span>
      </button>
      {!session.blank && (
        <div className="relative">
          <button
            type="button"
            title="更多"
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-colors hover:bg-muted/60 hover:text-foreground focus:opacity-100 group-hover:opacity-100",
              open && "opacity-100 bg-muted/60"
            )}
          >
            <MoreHorizontal className="size-4" />
          </button>
          {open && (
            <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border/60 bg-background p-1 shadow-xl">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                onClick={() => {
                  setOpen(false)
                  onRename?.(session.sessionId)
                }}
              >
                <Pencil className="size-3.5" /> 重命名
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                onClick={() => {
                  setOpen(false)
                  onFork?.(session.sessionId)
                }}
              >
                <GitBranch className="size-3.5" /> 分叉会话
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                onClick={() => {
                  setOpen(false)
                  onArchive?.(session.sessionId)
                }}
              >
                <Archive className="size-3.5" /> 归档会话
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 会话真实标题：session/title 事件投影（last-wins，基于首条用户消息）。 */
function sessionTitleOf(s: SessionSummary): string | null {
  const t = s.projections?.values?.title
  return typeof t === "string" && t.trim() ? t : null
}

/** 会话标题：优先投影 title；空白会话「新会话」；否则 cwd 目录名。 */
function sessionTitle(s: SessionSummary): string {
  const t = sessionTitleOf(s)
  if (t) return t
  if (s.blank) return "新会话"
  return s.cwd ? s.cwd.split(/[\\/]/).pop() || "会话" : "会话"
}

/** 会话行 label（header 展示用）：标题 + 相对时间。 */
export function sessionLabel(s: SessionSummary): string {
  return `${sessionTitle(s)} · ${relativeTime(s.updatedAt)}`
}

/** 相对时间（复刻官方「X分钟/X小时/X天」）。 */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min}分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时`
  const day = Math.floor(hr / 24)
  return `${day}天`
}
