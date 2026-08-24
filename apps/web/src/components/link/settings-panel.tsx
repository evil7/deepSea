// ---------------------------------------------------------------------------
// SettingsPanel —— 设置面板（复刻官方 dialog）：通用 / 模型 / 插件 / Agent 预设
// 四个 tab + 配置文件只读整页展示 + Agent 预设管理（复制/删除/设为默认）。
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Copy, Eye, FileText, Loader2, Trash2, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  AgentPresetEntry,
  AgentPresetListResult,
  AgentPresetReadResult,
  ModelCatalogEntry,
  PluginInventoryEntry,
  SettingsDocumentView,
} from "@/lib/deepc-link/protocol"

/** 权限 preset：permission.defaultPreset。 */
const PERMISSION_OPTIONS = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "危险完全访问" },
]

/** 外观：ui-theme.preference。 */
const THEME_OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
]

/** 语言：locale.preference。 */
const LOCALE_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
]

/** 繁忙时 Enter 键行为：ui-conversation.busyEnter。 */
const ENTER_OPTIONS = [
  { value: "queue", label: "排队发送" },
  { value: "steer", label: "直接发送" },
]

/** 设置面板导航项（对齐官方 section id）。 */
export type SettingsTabId = "general" | "models" | "plugins" | "presets"

const SETTINGS_NAV: { id: SettingsTabId; label: string }[] = [
  { id: "general", label: "通用设置" },
  { id: "models", label: "模型" },
  { id: "plugins", label: "插件" },
  { id: "presets", label: "Agent 预设" },
]

/** 插件 fiberPhase → 状态标签。 */
const PLUGIN_PHASE_LABEL: Record<string, string> = {
  active: "已挂载",
  loading: "加载中",
  pending: "等待依赖",
  failed: "挂载失败",
  unloading: "卸载中",
}

export interface SettingsPanelProps {
  open: boolean
  tab: SettingsTabId
  onTabChange: (tab: SettingsTabId) => void
  onClose: () => void

  // 当前值
  permission: string
  locale: string
  theme: string
  busyEnter: string
  modelCatalog: ModelCatalogEntry[]
  defaultModel: string
  defaultModelProvider: string
  plugins: PluginInventoryEntry[]
  pluginsLoaded: boolean
  agentPresets: AgentPresetListResult | null

  // 回调
  setPref: (ns: string, patch: Record<string, unknown>) => void
  readSettingsDocument: () => Promise<SettingsDocumentView | null>
  loadAgentPresets: () => void
  readAgentPreset: (id: string) => Promise<AgentPresetReadResult | null>
  copyAgentPreset: (from: string, id: string, name?: string) => Promise<boolean>
  removeAgentPreset: (id: string) => Promise<boolean>
  setDefaultAgentPreset: (id: string) => Promise<boolean>
}

export function SettingsPanel({
  open,
  tab,
  onTabChange,
  onClose,
  permission,
  locale,
  theme,
  busyEnter,
  modelCatalog,
  defaultModel,
  defaultModelProvider,
  plugins,
  pluginsLoaded,
  agentPresets,
  setPref,
  readSettingsDocument,
  loadAgentPresets,
  readAgentPreset,
  copyAgentPreset,
  removeAgentPreset,
  setDefaultAgentPreset,
}: SettingsPanelProps) {
  const [doc, setDoc] = useState<SettingsDocumentView | null>(null)

  const openDoc = async () => {
    const d = await readSettingsDocument()
    if (d) setDoc(d)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-150 w-180 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-border/60 p-3">
          <p className="px-3 pb-2 text-sm font-semibold">设置</p>
          {SETTINGS_NAV.map((item) => (
            <SettingsNavItem
              key={item.id}
              label={item.label}
              active={tab === item.id}
              onClick={() => onTabChange(item.id)}
            />
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {doc ? (
            <SettingsDocumentView doc={doc} onBack={() => setDoc(null)} />
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
                <span className="text-sm font-medium">
                  {SETTINGS_NAV.find((i) => i.id === tab)?.label}
                </span>
                <div className="flex items-center gap-2">
                  {tab === "general" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => void openDoc()}
                    >
                      打开配置文件
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    onClick={onClose}
                    title="关闭"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {tab === "general" && (
                  <>
                    <SettingsRow
                      title="权限"
                      desc="选择新会话的默认权限模式"
                      value={permission}
                      options={PERMISSION_OPTIONS}
                      onSelect={(v) => setPref("permission", { defaultPreset: v })}
                    />
                    <SettingsRow
                      title="语言"
                      value={locale}
                      options={LOCALE_OPTIONS}
                      onSelect={(v) => setPref("locale", { preference: v })}
                    />
                    <SettingsRow
                      title="外观"
                      value={theme}
                      options={THEME_OPTIONS}
                      onSelect={(v) => setPref("ui-theme", { preference: v })}
                    />
                    <SettingsRow
                      title="繁忙时 Enter 键行为"
                      desc="仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为"
                      value={busyEnter}
                      options={ENTER_OPTIONS}
                      onSelect={(v) => setPref("ui-conversation", { busyEnter: v })}
                    />
                  </>
                )}

                {tab === "models" && (
                  <>
                    <p className="pb-1 text-xs text-muted-foreground">
                      新会话默认使用的模型（agent-default-model）
                    </p>
                    {modelCatalog.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        未获取到可用模型目录
                      </div>
                    ) : (
                      modelCatalog.map((m) => (
                        <SettingsRow
                          key={m.id}
                          title={m.name}
                          desc={`id: ${m.id}${m.contextWindow ? ` · 上下文 ${m.contextWindow.toLocaleString()}` : ""}`}
                          value={m.id}
                          selected={m.id === defaultModel}
                          onSelectValue={() =>
                            setPref("agent-default-model", {
                              provider: defaultModelProvider,
                              model: m.id,
                            })
                          }
                        />
                      ))
                    )}
                  </>
                )}

                {tab === "plugins" && (
                  <>
                    <p className="pb-1 text-xs text-muted-foreground">
                      由 Host Loader 提供的插件清单（共 {plugins.length} 项，按启用状态排序）
                    </p>
                    {!pluginsLoaded ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        加载插件清单…
                      </div>
                    ) : plugins.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">无插件</div>
                    ) : (
                      [...plugins]
                        .toSorted((a, b) => Number(b.enabled) - Number(a.enabled))
                        .map((p) => (
                          <div
                            key={p.entryId}
                            className="flex items-center justify-between gap-3 border-b border-border/40 py-2"
                          >
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate font-mono text-xs",
                                p.enabled ? "text-foreground" : "text-muted-foreground/60"
                              )}
                            >
                              {p.moduleName}
                            </span>
                            <Badge
                              variant="outline"
                              className={cn(
                                "shrink-0 border-transparent text-[10px]",
                                p.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-500/15 text-slate-400"
                              )}
                            >
                              {p.enabled ? "启用" : "禁用"}
                            </Badge>
                            <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground">
                              {p.fiberPhase ? PLUGIN_PHASE_LABEL[p.fiberPhase] ?? p.fiberPhase : "未挂载"}
                            </span>
                          </div>
                        ))
                    )}
                  </>
                )}

                {tab === "presets" && (
                  <AgentPresetsSection
                    presets={agentPresets?.presets ?? []}
                    authorable={agentPresets?.authorable ?? false}
                    loading={agentPresets === null}
                    onLoad={loadAgentPresets}
                    onSelectDefault={setDefaultAgentPreset}
                    onView={readAgentPreset}
                    onCopy={copyAgentPreset}
                    onRemove={removeAgentPreset}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** 时间格式化（YYYY-MM-DD HH:mm，供配置文件「更新于」提示）。 */
function formatMtime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 配置文件只读整页展示：标题返回按钮 + 提示「来自哪个节点 / 更新于什么时间」。 */
function SettingsDocumentView({ doc, onBack }: { doc: SettingsDocumentView; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={onBack}>
          <ChevronLeft className="size-4" />
          返回设置
        </Button>
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <FileText className="size-4 text-muted-foreground" />
          配置文件
        </span>
        <span className="ml-auto truncate text-xs text-muted-foreground" title={doc.path}>
          来自 {doc.hostname} · 更新于 {formatMtime(doc.mtime)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/90">
          {doc.content}
        </pre>
      </div>
    </div>
  )
}

/** Agent 预设管理（复刻官方：卡片列表 + 设为默认 + 复制 + 只读查看 + 删除）。 */
function AgentPresetsSection({
  presets,
  authorable,
  loading,
  onLoad,
  onSelectDefault,
  onView,
  onCopy,
  onRemove,
}: {
  presets: AgentPresetEntry[]
  authorable: boolean
  loading: boolean
  onLoad: () => void
  onSelectDefault: (id: string) => Promise<boolean>
  onView: (id: string) => Promise<AgentPresetReadResult | null>
  onCopy: (from: string, id: string, name?: string) => Promise<boolean>
  onRemove: (id: string) => Promise<boolean>
}) {
  const [view, setView] = useState<AgentPresetReadResult | null>(null)
  const [copyFrom, setCopyFrom] = useState<AgentPresetEntry | null>(null)
  const [copyId, setCopyId] = useState("")
  const [copyName, setCopyName] = useState("")
  const [copySaving, setCopySaving] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    onLoad()
  }, [onLoad])

  const submitCopy = async () => {
    if (!copyFrom || !copyId.trim()) return
    setCopySaving(true)
    setCopyError(null)
    const ok = await onCopy(copyFrom.id, copyId.trim(), copyName.trim() || undefined)
    setCopySaving(false)
    if (ok) {
      setCopyFrom(null)
      setCopyId("")
      setCopyName("")
    } else {
      setCopyError("复制失败（id 可能已占用或部署不可写）")
    }
  }

  const confirmRemove = async () => {
    if (!deleteId) return
    setDeleting(true)
    await onRemove(deleteId)
    setDeleting(false)
    setDeleteId(null)
  }

  const openView = async (id: string) => {
    const r = await onView(id)
    if (r) setView(r)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载预设…
      </div>
    )
  }

  if (presets.length === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">未配置任何预设</div>
  }

  return (
    <div className="space-y-1">
      <p className="pb-1 text-xs text-muted-foreground">
        决定新会话的智能体组成。运行中的会话保持它开始时的预设。
      </p>
      {presets.map((p) => (
        <div key={p.id} className="flex items-center gap-3 border-b border-border/40 py-2.5">
          <button
            type="button"
            disabled={p.isDefault || !!p.broken}
            onClick={() => void onSelectDefault(p.id)}
            title={p.isDefault ? "当前默认" : "设为默认"}
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
              p.isDefault
                ? "border-primary bg-primary"
                : "border-muted-foreground/40 hover:border-primary/60",
              p.broken && "opacity-40"
            )}
          >
            {p.isDefault && <span className="size-1.5 rounded-full bg-primary-foreground" />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm text-foreground">{p.name ?? p.id}</span>
              {p.name && <span className="shrink-0 font-mono text-xs text-muted-foreground">{p.id}</span>}
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 border-transparent text-[10px]",
                  p.trust === "system" ? "bg-slate-500/15 text-slate-400" : "bg-amber-500/15 text-amber-400"
                )}
              >
                {p.trust === "system" ? "内置" : "自定义"}
              </Badge>
              {p.isDefault && (
                <Badge variant="outline" className="shrink-0 border-transparent bg-emerald-500/15 text-[10px] text-emerald-400">
                  默认
                </Badge>
              )}
            </div>
            {p.description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.description}</p>
            )}
            {p.broken && <p className="mt-0.5 text-xs text-rose-400">不可用：{p.broken}</p>}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => void openView(p.id)}
              title="查看 composition"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Eye className="size-3.5" />
            </button>
            {authorable && (
              <button
                type="button"
                onClick={() => {
                  setCopyFrom(p)
                  setCopyId("")
                  setCopyName("")
                  setCopyError(null)
                }}
                title="复制为自定义预设"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </button>
            )}
            {p.trust === "user" && (
              <button
                type="button"
                onClick={() => setDeleteId(p.id)}
                title="删除"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-rose-400"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      ))}

      {view && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setView(null)} />
          <div className="relative flex h-130 w-160 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
              <span className="text-sm font-medium">{view.name ?? view.agentPreset}</span>
              <Badge variant="outline" className="border-transparent text-[10px]">
                {view.trust === "system" ? "内置" : "自定义"}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-7 text-muted-foreground"
                onClick={() => setView(null)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/90">
                {view.content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {copyFrom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setCopyFrom(null)} />
          <div className="relative flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-2xl border border-border/60 bg-background p-4 shadow-2xl">
            <p className="text-sm font-semibold">复制预设：{copyFrom.name ?? copyFrom.id}</p>
            <label className="text-xs text-muted-foreground">
              新预设 id（目录名，必填）
              <input
                value={copyId}
                onChange={(e) => setCopyId(e.target.value)}
                placeholder="my-preset"
                className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-ring"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              显示名（可选，空则回退 id）
              <input
                value={copyName}
                onChange={(e) => setCopyName(e.target.value)}
                placeholder="My preset"
                className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-ring"
              />
            </label>
            {copyError && <p className="text-xs text-rose-400">{copyError}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCopyFrom(null)}>
                取消
              </Button>
              <Button size="sm" disabled={!copyId.trim() || copySaving} onClick={() => void submitCopy()}>
                {copySaving ? "复制中…" : "复制"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteId(null)} />
          <div className="relative flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-2xl border border-border/60 bg-background p-4 shadow-2xl">
            <p className="text-sm font-semibold">删除预设</p>
            <p className="text-xs text-muted-foreground">
              确定删除自定义预设「{deleteId}」吗？已按它组成的会话不受影响。
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDeleteId(null)}>
                取消
              </Button>
              <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void confirmRemove()}>
                {deleting ? "删除中…" : "删除"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 设置导航项。 */
function SettingsNavItem({
  label,
  active,
  onClick,
}: {
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
        active ? "bg-muted/60 text-foreground" : "text-muted-foreground hover:bg-muted/40"
      )}
    >
      {label}
    </button>
  )
}

/** 设置项行：标题 + 描述 + 当前值（可点选枚举 / 下拉 / 单选样式）。 */
function SettingsRow({
  title,
  desc,
  value,
  options,
  onSelect,
  selected,
  onSelectValue,
}: {
  title: string
  desc?: string
  value: string
  options?: { value: string; label: string }[]
  onSelect?: (value: string) => void
  selected?: boolean
  onSelectValue?: () => void
}) {
  if (onSelectValue) {
    return (
      <button
        type="button"
        onClick={onSelectValue}
        className={cn(
          "flex w-full items-center justify-between gap-4 border-b border-border/40 py-3 text-left transition-colors",
          selected ? "bg-muted/40" : "hover:bg-muted/20"
        )}
      >
        <div className="min-w-0">
          <p className="text-sm text-foreground">{title}</p>
          {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
        </div>
        {selected && <span className="shrink-0 text-xs text-emerald-400">当前</span>}
      </button>
    )
  }
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/40 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{title}</p>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {options ? (
        <div className="flex shrink-0 items-center gap-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect?.(opt.value)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs transition-colors",
                opt.value === value ? "bg-muted/70 text-foreground" : "text-muted-foreground hover:bg-muted/40"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted/40"
        >
          {value}
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
