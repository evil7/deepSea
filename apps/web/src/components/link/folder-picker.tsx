// ---------------------------------------------------------------------------
// FolderPicker —— 虚拟文件夹选择器（远程目录枚举 · Win/Unix 双模态）。
//
// 通过 deepc-link RPC（deepc.fs.*）枚举远端 host 的真实文件系统——
//   · deepc.fs.roots：顶层真实根（Windows 真实可访问盘符 / Unix 根 + home）
//   · deepc.fs.listDirectories：逐层枚举目录
// UI 渲染面包屑导航 + 目录列表 + 「返回上层」，取代系统原生文件选择窗口。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react"
import { ArrowUp, ChevronRight, Folder, Home, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { deepcClient } from "@/lib/deepc-link/client"

interface DirEntry {
  name: string
  isDir: boolean
  /** 绝对路径（deepc.fs.listDirectories 返回的 children.path；用于可靠进入子目录）。 */
  path: string
}

interface RootEntry {
  name: string
  path: string
}

export interface FolderPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  /** 远端 host 的 home 目录（用于初始路径 + OS 推断）。 */
  homePath?: string
}

/** 判断路径是否为 Windows 风格（以 盘符: 开头）。 */
function isWinPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p)
}

function getSep(isWin: boolean): string {
  return isWin ? "\\" : "/"
}

/** 当前路径的父目录（返回上层用）。 */
function parentPath(p: string, isWin: boolean): string | null {
  if (!p) return null
  const norm = p.replace(/[\\/]+$/, "")
  const parts = norm.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return null
  // Windows 根盘符（如 C:）无父级。
  if (isWin && parts.length === 1) return null
  // Unix 根 / 无父级。
  if (!isWin && parts.length === 1) return "/"
  const head = isWin ? `${parts[0]}:` : ""
  const rest = parts.slice(1, -1)
  const joined = rest.join(getSep(isWin))
  if (isWin) return rest.length ? `${head}\\${joined}` : `${head}\\`
  return "/" + (joined ? joined + "/" : "")
}

/**
 * 将路径拆为面包屑段。
 * Unix：["", "home", "user", "projects"]（首位空串代表根 /）。
 * Windows：["C:", "Users", "user", "projects"]。
 */
function splitSegments(p: string, isWin: boolean): string[] {
  if (!p) return []
  const parts = p.split(/[/\\]/).filter(Boolean)
  if (!isWin) return ["", ...parts]
  return parts
}

/** 从面包屑段重建路径（取前 index+1 段）。 */
function buildPath(segments: string[], index: number, isWin: boolean): string {
  const sliced = segments.slice(0, index + 1)
  if (!isWin && sliced[0] === "") {
    return "/" + sliced.slice(1).join("/")
  }
  return sliced.join(getSep(isWin))
}

/** 面包屑中带省略：中间段折叠为「…」。 */
function collapseSegments(segments: string[]): { type: "crumb" | "ellipsis"; value: string; index?: number }[] {
  if (segments.length <= 4) return segments.map((v, i) => ({ type: "crumb" as const, value: v, index: i }))
  const head = segments.slice(0, 2)
  const tail = segments.slice(-2)
  return [
    ...head.map((v, i) => ({ type: "crumb" as const, value: v, index: i })),
    { type: "ellipsis" as const, value: "…" },
    ...tail.map((v, i) => ({ type: "crumb" as const, value: v, index: head.length + i + 1 })),
  ]
}

export function FolderPicker({
  open,
  onOpenChange,
  onSelect,
  homePath = "",
}: FolderPickerProps) {
  const [isWindows, setIsWindows] = useState(() => isWinPath(homePath))
  const [currentPath, setCurrentPath] = useState(homePath)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [roots, setRoots] = useState<RootEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 调用远端 host 枚举目录（node 端 deepc.fs 本地能力）。 */
  const loadDir = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    setEntries([])
    try {
      const res = await deepcClient.call("deepc.fs.listDirectories", { path })
      if (res.ok && res.value) {
        const value = res.value as {
          path?: string
          children?: { name: string; kind: string; path: string }[]
        }
        // children 均为目录项（kind==='dir'），映射为 DirEntry + 带绝对 path。
        setEntries(
          (value.children ?? []).map((c) => ({
            name: c.name,
            isDir: c.kind === "dir",
            path: c.path,
          }))
        )
      } else {
        setError(res.ok ? "空响应" : (res.error?.message ?? "读取失败"))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "未知错误")
    }
    setLoading(false)
  }, [])

  // 打开时：拉真实根（盘符/根目录）+ 载入初始目录。
  useEffect(() => {
    if (!open) return
    setError(null)
    setEntries([])
    let cancelled = false
    // 拉顶层真实根（Windows 真实盘符 / Unix 根），确定 OS 与可用入口。
    void deepcClient
      .call("deepc.fs.roots", {})
      .then((res) => {
        if (cancelled) return
        const value = (res.ok && res.value) as
          | { home?: string; isWindows?: boolean; roots?: RootEntry[] }
          | undefined
        const home = value?.home ?? homePath
        const win = value?.isWindows ?? isWinPath(home)
        setIsWindows(win)
        setRoots(value?.roots ?? [])
        // 初始路径：优先 homePath，否则 roots 首项 / 盘符，否则 home。
        const initial =
          homePath ||
          (value?.roots?.length ? value.roots[0].path : value?.home || (win ? "C:\\" : "/"))
        setCurrentPath(initial)
        void loadDir(initial)
      })
      .catch(() => {
        if (cancelled) return
        const initial = homePath || (isWindows ? "C:\\" : "/")
        setCurrentPath(initial)
        void loadDir(initial)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, homePath, loadDir])

  /** 导航到指定路径。 */
  const navigate = useCallback(
    (path: string) => {
      setCurrentPath(path)
      setIsWindows(isWinPath(path))
      void loadDir(path)
    },
    [loadDir]
  )

  /** 进入子目录（用 children 的绝对 path，避免自拼路径出错）。 */
  const enterDir = useCallback(
    (path: string) => {
      navigate(path)
    },
    [navigate]
  )

  /** 返回上层。 */
  const goUp = useCallback(() => {
    const parent = parentPath(currentPath, isWindows)
    if (parent !== null) navigate(parent)
  }, [currentPath, isWindows, navigate])

  const segments = splitSegments(currentPath, isWindows)
  const crescents = collapseSegments(segments)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3">
        <DialogHeader>
          <DialogTitle>选择工作区目录</DialogTitle>
          <DialogDescription>
            浏览远端设备的文件系统，选择一个目录作为新工作区。
          </DialogDescription>
        </DialogHeader>

        {/* ── 面包屑导航（超长中间省略 + 返回上层）────────────────── */}
        <div className="flex items-center gap-0.5 overflow-x-auto text-xs">
          {/* 返回上层按钮 */}
          <button
            type="button"
            onClick={goUp}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted"
            title="返回上层"
          >
            <ArrowUp className="size-3.5" />
          </button>
          {/* 根/盘符入口（点击可在真实根间切换） */}
          <button
            type="button"
            onClick={() => {
              if (roots.length) navigate(roots[0].path)
            }}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted"
            title="根目录"
          >
            <Home className="size-3.5" />
            <span>{isWindows ? segments[0] || "根" : "/"}</span>
          </button>
          {/* 路径段（中间折叠 …） */}
          {crescents.map((c, idx) => {
            if (c.type === "ellipsis") {
              return (
                <span key={`ell-${idx}`} className="shrink-0 px-0.5 text-muted-foreground">
                  …
                </span>
              )
            }
            if (c.index === 0) return null
            return (
              <span key={c.index} className="flex items-center gap-0.5">
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => navigate(buildPath(segments, c.index!, isWindows))}
                  className="rounded px-1 py-0.5 transition-colors hover:bg-muted"
                >
                  {c.value}
                </button>
              </span>
            )
          })}
        </div>

        {/* ── 真实根入口（仅顶层/根时显示，可快速切换盘符根目录）────── */}
        {segments.length <= 1 && roots.length > 0 && (
          <div className="flex flex-wrap gap-1 rounded-lg border border-border/60 p-2">
            {roots.map((root) => (
              <Button
                key={root.path}
                variant={currentPath === root.path || currentPath === root.path + (isWindows ? "\\" : "") ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => navigate(root.path)}
              >
                {root.name}
              </Button>
            ))}
          </div>
        )}

        {/* ── 目录列表 ─────────────────────────────────────────── */}
        <ScrollArea className="h-80 rounded-lg border border-border/60">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              读取目录…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-1.5 px-3 py-10 text-center">
              <p className="text-xs text-destructive">{error}</p>
              <p className="text-xs text-muted-foreground">
                此 host 可能尚未支持目录枚举（deepc.fs.listDirectories）
              </p>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
              空目录
            </div>
          ) : (
            <div className="p-1">
              {entries.map((entry) => (
                <button
                  key={entry.path || entry.name}
                  type="button"
                  onClick={() => enterDir(entry.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* 当前路径 */}
        <p className="truncate text-xs text-muted-foreground">
          选择目录：{currentPath || "—"}
        </p>

        {/* ── 底部按钮 ─────────────────────────────────────────── */}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => onSelect(currentPath)}
            disabled={!currentPath || loading}
          >
            选择此目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
