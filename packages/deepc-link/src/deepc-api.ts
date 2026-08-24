/**
 * deepc-link node 端本地能力 API —— 拦截「apiProxy 域树之外」的方法，其余转发给 apiProxy。
 *
 * 定位：apiProxy 域树（session/workspace/host/settings/…）由 `ApiProxyLocalApi` 直连；
 * 本模块拦截两类「非 apiProxy 方法」：
 *   · `deepc.*` —— deepc 自建能力（纯 node 本地能力）：
 *       - deepc.os.hostname —— 返回本机主机名（node os.hostname，浏览器拿不到）
 *       - deepc.fs.roots / deepc.fs.listDirectories —— 扫描系统目录，供「新建工作区」选路径
 *       - deepc.settings.readDocument —— 读 settings 配置文件原文（供主站只读整页展示）
 *       - deepc.commands.list —— 查 dsh 已注册 slash 命令（对齐官方 / 命令联想）
 *   · `pluginInventory/list` —— typert Remote，Host 侧 cordis service 直连
 *
 * 【官方最佳实践】commands / pluginInventory 是 typert Remote，其 Host 面是 cordis
 * service（`ctx.commands` = CommandRuntime、`ctx.pluginInventory` = PluginInventoryGateway），
 * `invocation: { kind: 'direct' }` —— Host 进程内**直接调 cordis service 方法**，不走
 * HTTP 回环（`dsh-api-remotes` 注释：remote 仅在 Client 环境装配）。
 *
 *   · deepc.commands.list → `ctx.commands.list(agent)`（agent 由 `ctx.agents.get(sessionId)` 解析）
 *   · pluginInventory/list → `ctx.pluginInventory.list()`（无参，返回 { entries }）
 *
 * 实现：作为 LocalApi 的组合包装（装饰器），callUnary 先看是否命中上述拦截，命中则本地
 * 处理，否则委托给 next（ApiProxyLocalApi）。
 */

import { hostname, homedir } from 'node:os'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LocalApi } from './local-api'
import type { RpcResult, ServerRequest, StreamKind } from './protocol'

/** deepc.* 本地方法命名空间前缀。 */
const DEEPC_NS = 'deepc.'

/**
 * 拦截方法所需的宿主服务（可选，经 ctx.reflect.get 读取）。
 *   · commands —— ctx.commands（CommandRuntime）：list(agent) 返回 CommandDescriptor[]
 *   · agents   —— ctx.agents（AgentRegistry）：get(sessionId) → live Agent | undefined
 *   · pluginInventory —— ctx.pluginInventory（PluginInventoryGateway）：list() → { entries }
 * 类型用 any 避免强依赖 @deepseek-ai/dsh-commands / dsh-agent / dsh-host-plugin-inventory 类型包。
 */
interface DeepcHostServices {
  /** ctx.commands（CommandRuntime）：list(agent) 同步返回 CommandDescriptor[]。 */
  commands?: any
  /** ctx.agents（AgentRegistry）：get(sessionId) → live Agent | undefined。 */
  agents?: any
  /** ctx.pluginInventory（PluginInventoryGateway）：list() → { entries }。 */
  pluginInventory?: any
}

/** 目录扫描上限（防止超大目录卡死 node 事件循环）。 */
const MAX_DIR_ENTRIES = 64

/** RPC 成功结果。 */
function ok(value: unknown): RpcResult {
  return { ok: true, value }
}

/** RPC 失败结果。 */
function fail(code: string, message: string): RpcResult {
  return { ok: false, error: { code, message } }
}

/** 目录项（供前端渲染目录树）。 */
export interface DirEntry {
  name: string
  kind: 'dir' | 'file'
  path: string
}

/**
 * 读取 dsh settings 配置文件原文（`settings.yaml`）+ 元数据，供主站设置页
 * 只读整页展示。
 *
 * 定位：官方 `settings.openDocument` 只把文档交给平台文本编辑器打开（返回
 * `{ opened: true }`，不回传内容），对浏览器主站无用——远端 host 打开编辑器
 * 用户看不到。故新增本命令，由 host 进程直接读文件原文 + mtime + 主机名，
 * 回传给主站只读展示，并标注「来自哪个节点 / 更新于什么时间」。
 *
 * 路径对齐官方 `dsh-home-paths` resolveDshHome：`$DSH_HOME` 覆盖，默认 `~/.dsh`。
 */
async function readSettingsDocument(): Promise<RpcResult> {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const file = join(dshHome, 'settings.yaml')
  try {
    const [content, st] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return ok({
      content,
      path: file,
      hostname: hostname(),
      mtime: st.mtimeMs,
    })
  } catch (error) {
    return fail(
      'settings-document-unavailable',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** 深读取一个目录的子项（name + kind + 相对路径），供前端渲染目录树。 */
async function listDir(base: string, depth = 1): Promise<DirEntry[] | null> {
  if (depth > 2) return [] // 只展开两层的子目录，避免爆炸
  const out: DirEntry[] = []
  try {
    const entries = await readdir(base, { withFileTypes: true })
    for (const ent of entries.slice(0, MAX_DIR_ENTRIES)) {
      const isDir = ent.isDirectory()
      if (!isDir) continue // 工作区只列目录
      // 跳过隐藏目录与 node_modules
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
      out.push({ name: ent.name, kind: 'dir', path: resolve(base, ent.name) })
    }
  } catch {
    return null // 无权读取/不存在
  }
  return out
}

/** Windows 真实可访问根盘符（枚举 A-Z 探测存在性）→ DirEntry[]。 */
async function listWindowsRoots(): Promise<DirEntry[]> {
  const drives: DirEntry[] = []
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const letter = String.fromCharCode(c)
    const p = `${letter}:\\`
    try {
      await access(p)
      drives.push({ name: `${letter}:`, kind: 'dir', path: p })
    } catch {
      // 盘符不存在，跳过
    }
  }
  // 兜底：若探测全失败（非典型环境），至少列 home。
  if (drives.length === 0) {
    const home = homedir()
    drives.push({ name: '~', kind: 'dir', path: home })
  }
  return drives
}

/**
 * 构造本地拦截处理器：命中拦截方法则返回结果，否则返回 null 表示「转下游（apiProxy）」。
 */
async function handleDeepc(
  method: string,
  payload: unknown,
  svc?: DeepcHostServices,
): Promise<RpcResult | null> {
  // 非 deepc.* 前缀：仅 pluginInventory/list 属本模块拦截，其余转下游。
  if (!method.startsWith(DEEPC_NS) && method !== 'pluginInventory/list') return null

  if (method === 'deepc.os.hostname') {
    return ok({ hostname: hostname() })
  }

  if (method === 'deepc.fs.roots') {
    // 顶层真实根：Windows 枚举真实可访问盘符，Unix 返回根路径 '/' + home。
    const home = homedir()
    const isWin = process.platform === 'win32'
    let roots: DirEntry[]
    if (isWin) {
      roots = await listWindowsRoots()
    } else {
      roots = [
        { name: '/', kind: 'dir', path: '/' },
        { name: '~', kind: 'dir', path: home },
      ]
    }
    return ok({ home, isWindows: isWin, roots })
  }

  if (method === 'deepc.fs.listDirectories') {
    const p = (payload as { path?: unknown; depth?: unknown } | undefined) ?? {}
    const depth = typeof p.depth === 'number' ? p.depth : 1
    // 有 path 则深读该目录，否则读 home 下的一层。
    const req = typeof p.path === 'string' && p.path.trim() ? p.path : homedir()
    const base = resolve(req)
    const children = await listDir(base, depth)
    return ok({ path: base, children: children ?? [] })
  }

  // deepc.settings.readDocument —— 读 settings 配置文件原文（供主站只读整页展示）。
  if (method === 'deepc.settings.readDocument') {
    return readSettingsDocument()
  }

  // deepc.commands.list —— 查 dsh 已注册 slash 命令（对齐官方 / 命令联想）。
  // 单一来源：ctx.commands.list(agent)，agent 由 ctx.agents.get(sessionId) 解析。
  if (method === 'deepc.commands.list') {
    if (!svc?.commands) {
      return fail('commands-unavailable', 'host 未提供 commands 服务')
    }
    const p = (payload as { sessionId?: unknown } | undefined) ?? {}
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined
    try {
      // agentId 与 sessionId 一一对应（官方 typert wire 即如此解释）。
      const agent = sessionId ? svc.agents?.get?.(sessionId) : undefined
      const items: unknown[] = svc.commands.list(agent ?? {}) ?? []
      const list = items.map((c: any) => ({
        name: c?.name ?? '',
        description: c?.description ?? '',
        hint: c?.input?.hint,
      }))
      return ok({ items: list })
    } catch (error) {
      return fail('commands-error', error instanceof Error ? error.message : String(error))
    }
  }

  // pluginInventory/list —— typert Remote，Host 侧 cordis service 直连（官方最佳实践）。
  if (method === 'pluginInventory/list') {
    if (!svc?.pluginInventory) {
      return fail('plugin-inventory-unavailable', 'host 未提供 pluginInventory 服务')
    }
    try {
      const snapshot = await svc.pluginInventory.list()
      return ok(snapshot)
    } catch (error) {
      return fail('plugin-inventory-error', error instanceof Error ? error.message : String(error))
    }
  }

  return fail('unknown-method', `deepc 方法不存在: ${method}`)
}

/** 组合包装：deepc.* 本地处理，其余委托 next。 */
export function wrapLocalApi(next: LocalApi, svc?: DeepcHostServices): LocalApi {
  return {
    async callUnary(method: string, payload: unknown): Promise<RpcResult> {
      const local = await handleDeepc(method, payload, svc)
      if (local !== null) return local
      return next.callUnary(method, payload)
    },
    subscribe(stream: StreamKind, onFrame: (env: ServerRequest) => void): () => void {
      return next.subscribe(stream, onFrame)
    },
  }
}
