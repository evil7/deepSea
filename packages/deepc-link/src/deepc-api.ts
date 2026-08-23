/**
 * deepc-link node 端本地能力 API —— 拦截 `deepc.*` 方法，其余转发给宿主 API。
 *
 * 定位：把「远端 chatUI 经 DataChannel 发来的 deepc 命名空间调用」落到 node 端本地实现。
 *   · deepc.os.hostname —— 返回本机主机名（node os.hostname，浏览器拿不到）
 *   · deepc.fs.listDirectories —— 扫描常用目录（home/cwd 上级），供「新建工作区」选目录
 * 其余方法（session.* / workspace.* / llm.* / ...）转发给底层 LocalApi（HttpLocalApi）。
 *
 * 实现：作为 LocalApi 的组合包装（装饰器），callUnary 先看 method 前缀是否 deepc.*，
 * 是则本地处理，否则委托给 next。
 */

import { hostname, homedir } from 'node:os'
import { access, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LocalApi } from './local-api'
import type { RpcResult, ServerRequest, StreamKind } from './protocol'

/** deepc.* 本地方法命名空间前缀。 */
const DEEPC_NS = 'deepc.'

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
 * 构造本地 deepc 方法处理器：命中 deepc.* 则返回结果，否则返回 null 表示「转下游」。
 */
async function handleDeepc(method: string, payload: unknown): Promise<RpcResult | null> {
  if (!method.startsWith(DEEPC_NS)) return null

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

  return fail('unknown-method', `deepc 方法不存在: ${method}`)
}

/** 组合包装：deepc.* 本地处理，其余委托 next。 */
export function wrapLocalApi(next: LocalApi): LocalApi {
  return {
    async callUnary(method: string, payload: unknown): Promise<RpcResult> {
      const local = await handleDeepc(method, payload)
      if (local !== null) return local
      return next.callUnary(method, payload)
    },
    subscribe(stream: StreamKind, onFrame: (env: ServerRequest) => void): () => void {
      return next.subscribe(stream, onFrame)
    },
  }
}
