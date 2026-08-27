// ---------------------------------------------------------------------------
// /link/:nodeId —— 远端节点统一路径包装页（沉浸式全屏 iframe）。
//
// 目的：主站打开远端 dsh 时**不在地址栏暴露** trycloudflare / 自定义域 URL，
//       而是停留在 deepc.cn/link/<nodeId>，由 iframe 内嵌节点页面。
//
// 连接流程：
//   1. listTunnels 找到节点（归属校验）→ 无则错误态（可能已删除/非本账号）。
//   2. requestAccess 拿一次性 ticket（主站签 HMAC，bypass 启用时）→ 隐藏 form
//      POST 到 iframe（target=iframe name）→ 3081 验签 → 种分区 cookie
//      （SameSite=None; Secure; Partitioned）→ 302 进入 dsh。iframe 内的后续
//      请求自动携带该分区 cookie，免手动 2FA。
//   3. bypass 未启用 / 无权限 → iframe 直接加载节点 URL，3081 返回内置 2FA
//      鉴权页，用户在 iframe 内手动输入动态码（局部 reload，不影响主站）。
//
// 配套（插件侧 3081）：auth-proxy.ts 剥离 X-Frame-Options / CSP frame-ancestors，
// 否则 dsh 页面会被浏览器拒绝嵌入（见 packages/deepc-link/src/auth-proxy.ts）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  MonitorPlay,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  listTunnels,
  requestAccess,
  type TunnelNodeView,
  type TunnelTicket,
} from "@/lib/deepc-link/tunnels"

/** iframe name：form POST ticket 的 target（3081 验签后 302 进 dsh）。 */
const FRAME_NAME = "deepc-node-frame"

/**
 * iframe sandbox 最小必要权限。内容为已鉴权可信节点（主站 ticket / 3081 TOTP
 * 双重验证）。allow-scripts + allow-same-origin 组合是 dsh 页面硬性要求：
 *    · allow-same-origin —— iframe 需真实 origin 才能携带分区 cookie（Partitioned）
 *      与 localStorage（否则 opaque origin 不带任何 cookie，3081 鉴权必然失败）；
 *    · allow-scripts —— dsh 是 SPA，必须有脚本；
 *    · allow-forms / allow-popups / allow-modals —— 登录表单、新窗口与模态交互。
 * 跨域隔离仍由同源策略保证（iframe 无法触达主站 DOM/cookie）。
 */
const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"

type Phase = "loading" | "ready" | "error"

/** 从完整 URL 提取前方二级域字段展示（如 surround-magnetic-belly-intelligent）。 */
function prettyHost(url: string): string {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    host = url.replace(/^https?:\/\//, "")
  }
  return host.split(".")[0] || ""
}

/** 提交一次性 ticket 到隧道（form urlencoded POST，target 指向内嵌 iframe；
 *  3081 验签后种分区 cookie 302 进入，iframe 内免手动 2FA）。 */
function postTicketToFrame(url: string, ticket: TunnelTicket): void {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = `${url.replace(/\/+$/, "")}/__deepc_ticket`
  form.target = FRAME_NAME
  const fields: Record<string, string> = {
    nodeId: ticket.nodeId,
    ts: String(ticket.ts),
    nonce: ticket.nonce,
    sig: ticket.sig,
  }
  for (const [k, v] of Object.entries(fields)) {
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = k
    input.value = v
    form.appendChild(input)
  }
  document.body.appendChild(form)
  form.submit()
  form.remove()
}

export function LinkViewPage() {
  const { t } = useTranslation()
  const { nodeId = "" } = useParams<{ nodeId: string }>()
  const navigate = useNavigate()

  const [phase, setPhase] = useState<Phase>("loading")
  const [node, setNode] = useState<TunnelNodeView | null>(null)
  /** totp 模式：iframe 直接加载的节点 URL；ticket 模式保持 null（仅由 form POST 导航）。 */
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  /** 主站签发的一次性 ticket（bypass 模式）。 */
  const [ticket, setTicket] = useState<TunnelTicket | null>(null)
  /** iframe 覆盖层：ticket POST / 页面加载完成前显示「正在连接」。 */
  const [connecting, setConnecting] = useState(true)
  const [copied, setCopied] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  /** ticket 是否已 POST 到 iframe（onLoad 据此区分 about:blank 初始加载 vs 真实导航）。 */
  const postedRef = useRef(false)
  /** 刷新计数：重建 iframe（旧 ticket nonce 已用，须重新签发）。 */
  const bootIdRef = useRef(0)

  /** 重置连接态（事件处理器内调用，合法同步 setState）。 */
  const reset = useCallback(() => {
    postedRef.current = false
    setPhase("loading")
    setConnecting(true)
    setFrameSrc(null)
    setTicket(null)
  }, [])

  const bootstrap = useCallback(async () => {
    const bootId = ++bootIdRef.current
    postedRef.current = false
    // 注意：不在 effect 的同步路径里 setState（React Compiler lint）。
    // 首次挂载 state 已是初始值；刷新由 onClick 先调 reset() 再调本函数。
    const rows = await listTunnels()
    if (bootId !== bootIdRef.current) return // 已发起新一次加载
    const found = rows.find((r) => r.nodeId === nodeId)
    if (!found || !found.url) {
      setPhase("error")
      return
    }
    setNode(found)
    setPhase("ready")

    // 优先免密直连（bypass）：主站签一次性 ticket → form POST 到 iframe 自动进入。
    // 未启用 / 无权限：iframe 直接加载节点 URL（3081 鉴权页内手动输 TOTP）。
    const access = await requestAccess(nodeId)
    if (bootId !== bootIdRef.current) return
    if (access) {
      setTicket(access.ticket)
      setFrameSrc(null)
    } else {
      setTicket(null)
      setFrameSrc(found.url)
    }
  }, [nodeId])

  useEffect(() => {
    // setTimeout 宏任务：避免 effect 同步路径里调用含 setState 的 bootstrap
    // （React Compiler set-state-in-effect lint）。
    const id = window.setTimeout(() => void bootstrap(), 0)
    return () => window.clearTimeout(id)
  }, [bootstrap])

  // 刷新：先重置（事件处理器内同步 setState），再重新拉节点 + 签新 ticket。
  const handleRefresh = () => {
    reset()
    void bootstrap()
  }

  // ticket 模式：iframe 挂载后向它 POST 一次性 ticket（target=iframe name）。
  // setTimeout 等 React 提交 DOM、frameRef 就绪；期间 iframe 保持 about:blank。
  useEffect(() => {
    if (phase !== "ready" || frameSrc !== null || !ticket || !node) return
    const id = window.setTimeout(() => {
      if (frameRef.current) {
        postedRef.current = true
        postTicketToFrame(node.url, ticket)
      }
    }, 60)
    return () => window.clearTimeout(id)
  }, [phase, frameSrc, ticket, node])

  // iframe 真实导航完成（ticket 已 POST 或 totp 模式直连）→ 隐藏「正在连接」覆盖层。
  // 不再依赖读 src 判定：about:blank 初始加载的 load 事件（postedRef=false）不隐藏。
  const handleFrameLoad = () => {
    if (postedRef.current || frameSrc !== null) setConnecting(false)
  }

  // 超时兜底：某些浏览器/网络下 iframe load 事件可能丢失或延迟，
  // 6s 后强制隐藏覆盖层（即使未触发 load，用户也能看到 iframe 内实际状态）。
  useEffect(() => {
    if (phase !== "ready") return
    const id = window.setTimeout(() => setConnecting(false), 6_000)
    return () => window.clearTimeout(id)
  }, [phase])

  const handleCopy = () => {
    if (!node) return
    void navigator.clipboard.writeText(node.url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const handleOpenNewWindow = () => {
    if (!node) return
    window.open(node.url, "_blank", "noopener")
  }

  return (
    // h-full + flex-1 双保险：flex 布局由 flex-1 撑满，h-full 兜底非 flex 计算
    // 链路断裂（父级高度确定时 height:100% 解析），保证 iframe 满屏高度。
    <main className="flex h-full min-h-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
      {/* —— 顶部工具条：返回 + 节点名 + 精简地址 + 操作 —— */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate("/links")}
          title={t("linkView.back")}
          className="shrink-0"
        >
          <ArrowLeft />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <MonitorPlay className="size-4" />
          </div>
          <span className="truncate text-sm font-medium">{node?.name ?? "…"}</span>
        </div>
        {node && (
          <span className="hidden shrink-0 items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs text-muted-foreground sm:flex">
            <Globe className="size-3" />
            {prettyHost(node.url)}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleCopy}>
            {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
            <span className="hidden md:inline">{t("linkView.copyUrl")}</span>
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleOpenNewWindow}>
            <ExternalLink className="size-3.5" />
            <span className="hidden md:inline">{t("linkView.openInNewWindow")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={handleRefresh}
          >
            <RefreshCw className="size-3.5" />
            <span className="hidden md:inline">{t("linkView.refresh")}</span>
          </Button>
        </div>
      </div>

      {/* —— 主体：内嵌节点 iframe（地址栏保持 /link/<nodeId>） —— */}
      <div className="relative h-full min-h-0 flex-1 overflow-hidden rounded-xl border bg-background shadow-sm">
        {phase === "loading" && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Loader2 className="size-6 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">{t("linkView.loading")}</span>
          </div>
        )}

        {phase === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <TriangleAlert className="size-8 text-amber-400" />
            <p className="text-sm font-medium">{t("linkView.notFound")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {t("linkView.notFoundDesc")}
            </p>
            <Button size="sm" onClick={() => navigate("/links")}>
              {t("linkView.backToLinks")}
            </Button>
          </div>
        )}

        {phase === "ready" && node && (
          <>
            {/* iframe 内容为已鉴权可信节点（主站 ticket / 3081 TOTP 双重验证），
                sandbox 权限见 FRAME_SANDBOX 注释（must 保留 allow-same-origin 保分区 cookie）。
                尺寸用 absolute inset-0 贴满容器：flex 链下 height:100% 对 replaced
                元素解析不可靠（实测回退 150px），绝对定位不依赖父级高度 definite。 */}
            <iframe
              ref={frameRef}
              name={FRAME_NAME}
              title={node.name}
              src={frameSrc ?? undefined}
              onLoad={handleFrameLoad}
              sandbox={FRAME_SANDBOX}
              className="absolute inset-0 h-full w-full border-0 bg-background"
            />
            {connecting && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
                <Loader2 className="size-6 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">{t("linkView.connecting")}</span>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  )
}

export default LinkViewPage
