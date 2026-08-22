// ---------------------------------------------------------------------------
// FolderPicker —— 虚拟文件夹选择器（远程目录枚举 · Win/Unix 双模态）。
//
// 通过 deepc-bridge RPC（deepc.fs.listDirectories）枚举远端 host 的目录树——
// 该方法是 node 插件端本地能力（node:fs），返回 { path, children:[{name,kind,path}] }，
// 跨设备枚举真实本机目录。UI 渲染面包屑导航 + 目录列表，取代系统原生文件选择窗口。
// Windows 模式：面包屑前方可切换盘符（C: D: E: …）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react"
import { ChevronRight, Folder, HardDrive, Home, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { deepcClient } from "@/lib/deepc-bridge/client"
import { cn } from "@/lib/utils"

interface DirEntry {
  name: string
  isDir: boolean
  /** 绝对路径（deepc.fs.listDirectories 返回的 children.path；用于可靠进入子目录）。 */
  path: string
}

export interface FolderPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  /** 远端 host 的 home 目录（用于初始路径 + OS 推断）。 */
  homePath?: string
}

const WINDOWS_DRIVES = [
  "C:", "D:", "E:", "F:", "G:", "H:", "I:", "J:", "K:", "L:", "M:",
  "N:", "O:", "P:", "Q:", "R:", "S:", "T:", "U:", "V:", "W:", "X:",
  "Y:", "Z:",
]

/** 判断路径是否为 Windows 风格（以 盘符: 开头）。 */
function isWinPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p)
}

function getSep(isWin: boolean): string {
  return isWin ? "\\" : "/"
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

export function FolderPicker({
  open,
  onOpenChange,
  onSelect,
  homePath = "",
}: FolderPickerProps) {
  const [isWindows, setIsWindows] = useState(() => isWinPath(homePath))
  const [currentPath, setCurrentPath] = useState(homePath)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState("")
  const [showDrives, setShowDrives] = useState(false)

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

  // 打开时加载初始目录。
  useEffect(() => {
    if (!open) return
    const initial = homePath || (isWindows ? "C:\\" : "/")
    setCurrentPath(initial)
    setManualPath(initial)
    setIsWindows(isWinPath(initial))
    void loadDir(initial)
    setShowDrives(false)
  }, [open, homePath, isWindows, loadDir])

  /** 导航到指定路径。 */
  const navigate = useCallback(
    (path: string) => {
      setCurrentPath(path)
      setManualPath(path)
      setIsWindows(isWinPath(path))
      setShowDrives(false)
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

  const segments = splitSegments(currentPath, isWindows)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle>选择工作区目录</DialogTitle>
          <DialogDescription>
            浏览远端设备的文件系统，选择一个目录作为新工作区。
          </DialogDescription>
        </DialogHeader>

        {/* ── 面包屑导航 ───────────────────────────────────────── */}
        <div className="flex items-center gap-0.5 overflow-x-auto text-xs">
          {/* Windows：盘符按钮（点击展开盘符列表） */}
          {isWindows && (
            <button
              type="button"
              onClick={() => setShowDrives((v) => !v)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted",
                showDrives && "bg-muted"
              )}
            >
              <HardDrive className="size-3.5" />
              {segments[0] || "C:"}
            </button>
          )}
          {/* Unix：根目录按钮 */}
          {!isWindows && (
            <button
              type="button"
              onClick={() => navigate("/")}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted"
            >
              <Home className="size-3.5" />
              <span>/</span>
            </button>
          )}
          {/* 路径段 */}
          {segments.map((seg, i) => {
            // 首段已由上方盘符/根按钮展示，跳过。
            if (i === 0) return null
            return (
              <span key={i} className="flex items-center gap-0.5">
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => navigate(buildPath(segments, i, isWindows))}
                  className="rounded px-1 py-0.5 transition-colors hover:bg-muted"
                >
                  {seg}
                </button>
              </span>
            )
          })}
        </div>

        {/* ── Windows 盘符选择器 ───────────────────────────────── */}
        {showDrives && isWindows && (
          <div className="flex flex-wrap gap-1 rounded-lg border border-border/60 p-2">
            {WINDOWS_DRIVES.map((drive) => (
              <Button
                key={drive}
                variant={segments[0] === drive ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  navigate(`${drive}\\`)
                  setShowDrives(false)
                }}
              >
                {drive}
              </Button>
            ))}
          </div>
        )}

        {/* ── 手动路径输入 ─────────────────────────────────────── */}
        <div className="flex items-center gap-2">
          <Input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(manualPath)
            }}
            placeholder={isWindows ? "C:\\Users\\..." : "/home/..."}
            className="h-8 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            onClick={() => navigate(manualPath)}
          >
            前往
          </Button>
        </div>

        {/* ── 目录列表 ─────────────────────────────────────────── */}
        <ScrollArea className="h-64 rounded-lg border border-border/60">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              读取目录…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-1.5 px-3 py-10 text-center">
              <p className="text-xs text-destructive">{error}</p>
              <p className="text-xs text-muted-foreground">
                此 host 可能尚未支持目录枚举（deepc.fs.listDirectories），请手动输入路径
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
