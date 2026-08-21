// ---------------------------------------------------------------------------
// /sonar —— 操作互联（deepc-bridge 远程控制 · 自实现 chatUI）
//
// 复刻官方前端结构：
//   左 sidebar —— 工作区 + 会话列表（workspace.list + session.list）
//   右聊天区 —— 消息流（session.history 折叠）+ 思考/审计板块 + 输入框
// 数据经 deepc-bridge 加密 RTC 通道（WebRTC DataChannel）访问本地 dsh host。
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react"
import { Link2, Loader2, Radio, RefreshCw, SendHorizonal, Unplug } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/layout/page-header"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"
import { ChatMessageList } from "@/components/sonar/chat-message"
import { useDeepcBridge } from "@/hooks/use-deepc-bridge"
import { cn } from "@/lib/utils"
import type { ClientState } from "@/lib/deepc-bridge/client"
import type { SessionSummary } from "@/lib/deepc-bridge/protocol"

const STATE_META: Record<ClientState, { label: string; tone: string }> = {
  idle: { label: "未连接", tone: "bg-slate-500/20 text-slate-300" },
  connecting: { label: "连接中…", tone: "bg-sky-500/20 text-sky-300" },
  connected: { label: "已连接", tone: "bg-emerald-500/20 text-emerald-300" },
  error: { label: "配对失败", tone: "bg-rose-500/20 text-rose-300" },
  disconnected: { label: "已断开", tone: "bg-slate-500/20 text-slate-300" },
}

const TOPBAR_H = 64

export function SonarPage() {
  const {
    state,
    hostInfo,
    error,
    workspaces,
    sessions,
    activeSessionId,
    messages,
    loading,
    connect,
    disconnect,
    selectSession,
    sendPrompt,
    loadWorkspace,
  } = useDeepcBridge()

  const [pairCode, setPairCode] = useState("")
  const [draft, setDraft] = useState("")
  const viewportRef = useRef<HTMLDivElement | null>(null)

  // 消息流自动滚动到底部。
  useEffect(() => {
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const connected = state === "connected"

  const handleConnect = () => {
    const code = pairCode.trim().toUpperCase()
    if (!code) return
    void connect(code)
  }

  const handleSend = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    await sendPrompt(text)
  }

  // ── 未连接态：输入临时口令 ───────────────────────────────────────────────
  if (!connected) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="size-5 text-primary" />
              连接本机 dsh
            </CardTitle>
            <CardDescription>
              在dsh端生成临时口令，启动临时互联
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
              placeholder="8 位临时口令"
              className="text-center font-mono text-2xl uppercase tracking-[0.25em]"
              maxLength={8}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConnect()
              }}
            />
            {state === "error" && error && (
              <p className="text-center text-sm text-rose-400">{error}</p>
            )}
            <Button
              onClick={handleConnect}
              disabled={!pairCode.trim() || state === "connecting"}
              className="w-full gap-2"
            >
              {state === "connecting" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Link2 className="size-4" />
              )}
              连接
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  // ── 已连接态：左 sidebar 工作区 + 右聊天区 ───────────────────────────────
  return (
    <div
      className="flex flex-col"
      style={{ height: `calc(100dvh - ${TOPBAR_H}px)` }}
    >
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <PageHeader
          title={
            <span className="flex items-center gap-2.5">
              操作互联
              <Badge variant="outline" className={cn("border-transparent", STATE_META[state].tone)}>
                {STATE_META[state].label}
              </Badge>
            </span>
          }
          description={
            hostInfo
              ? `${hostInfo.provider ?? "?"} · ${hostInfo.model ?? "?"} · ${hostInfo.cwd}`
              : "deepc-bridge 远程控制"
          }
          sticky={false}
          className="pt-2"
          actions={
            <Button
              onClick={disconnect}
              variant="outline"
              className="gap-2 border-amber-400/40 bg-amber-400/10 text-amber-300 hover:border-amber-400/60 hover:bg-amber-400/20 hover:text-amber-200 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300 dark:hover:border-amber-400/60 dark:hover:bg-amber-400/20 dark:hover:text-amber-200"
            >
              <Unplug className="size-4" />
              断开
            </Button>
          }
          showTopButton={false}
        />
      </div>

      <div className="mx-auto min-h-0 w-full max-w-7xl flex-1 overflow-hidden px-4 pb-4 sm:px-6">
        <SidebarProvider
          defaultOpen
          className="min-h-0 overflow-hidden rounded-xl border border-white/10 bg-background"
        >
          <Sidebar collapsible="none" className="border-r">
            <SidebarHeader className="gap-1">
              <p className="px-2 font-semibold text-sm">工作区</p>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-xs text-muted-foreground"
                onClick={() => {
                  void loadWorkspace()
                }}
              >
                <RefreshCw className="size-3.5" />
                刷新
              </Button>
            </SidebarHeader>
            <SidebarContent>
              {workspaces.length === 0 && (
                <SidebarGroup>
                  <SidebarGroupLabel>无工作区</SidebarGroupLabel>
                </SidebarGroup>
              )}
              {workspaces.map((ws) => {
                const wsSessions = ws.sessionIds
                  .map((id) => sessions.find((s) => s.sessionId === id))
                  .filter((s): s is SessionSummary => Boolean(s))
                return (
                  <SidebarGroup key={ws.workspaceId}>
                    <SidebarGroupLabel className="truncate">
                      {ws.title || ws.path}
                    </SidebarGroupLabel>
                    <SidebarMenu>
                      {wsSessions.map((s) => (
                        <SessionItem
                          key={s.sessionId}
                          sessionId={s.sessionId}
                          label={sessionLabel(s)}
                          active={activeSessionId === s.sessionId}
                          onSelect={selectSession}
                        />
                      ))}
                    </SidebarMenu>
                  </SidebarGroup>
                )
              })}
            </SidebarContent>
          </Sidebar>

          <SidebarInset className="min-h-0">
            <div className="flex h-full flex-col">
              {/* 消息流 */}
              <div
                ref={viewportRef}
                className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
              >
                {loading ? (
                  <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    加载会话…
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    选择左侧会话，或发送第一条消息开始
                  </div>
                ) : (
                  <div className="mx-auto max-w-3xl">
                    <ChatMessageList nodes={messages} />
                  </div>
                )}
              </div>

              {/* 输入框 */}
              <div className="border-t p-3">
                <div className="mx-auto flex max-w-3xl items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={activeSessionId ? "发送消息…" : "请先选择会话"}
                    disabled={!activeSessionId}
                    rows={2}
                    className="min-h-0 resize-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        void handleSend()
                      }
                    }}
                  />
                  <Button
                    onClick={() => void handleSend()}
                    disabled={!activeSessionId || !draft.trim()}
                    size="icon"
                    className="shrink-0"
                  >
                    <SendHorizonal className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </div>
    </div>
  )
}

function SessionItem({
  sessionId,
  label,
  active,
  onSelect,
}: {
  sessionId: string
  label: string
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={() => void onSelect(sessionId)}
        className="w-full justify-start text-left"
      >
        <span className="truncate">{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function sessionLabel(s: SessionSummary): string {
  const time = new Date(s.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
  const dir = s.cwd ? s.cwd.split(/[\\/]/).pop() : "会话"
  return `${dir} · ${time}`
}

export default SonarPage
