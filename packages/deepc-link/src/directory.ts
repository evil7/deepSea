/**
 * deepc-link 目录枚举 —— 共享给 node 半（/deepc/list-dir|create-dir）与历史
 * 3081 鉴权代理（原 /__deepc_api/* 已退役，逻辑迁入本模块）。
 *
 * 用途：为「工作区目录选择」浏览器内 UI 提供数据源——单层目录列表 + 祖先面包屑 +
 * 单层子目录创建。符号链接跟随判定、断链/循环链接跳过。
 *
 * 安全边界：
 *   · 这是给「本机操作者」浏览/选择本机目录的功能（等价于 dsh 官方 pickDirectory/listDirectory），
 *     天然是整机文件系统浏览，不做路径白名单（否则无法选择任意工作区）。
 *   · 远端访问经 3081 反代时，请求先过 TOTP 2FA（dc_site cookie）才到达 /deepc/*。
 *   · createDirectory 名称强制单段（无 / 或 \），防路径注入。
 */

import { access, mkdir, opendir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

/** 目录枚举上限（防大目录拖垮；与 dsh browse 后端一致取 1000）。 */
export const DIR_MAX_ENTRIES = 1000

/** 目录条目（面包屑与子目录共用此形状；面包屑 hidden 恒 false）。 */
export interface DirEntry {
  name: string
  path: string
  hidden: boolean
}

/** 面包屑条目（祖先链）。 */
export type DirCrumb = DirEntry

/** 单层目录列表响应（对齐 dsh host.listDirectory 的 DirectoryListing 形状）。 */
export interface DirectoryListing {
  ok: true
  path: string
  home: string
  crumbs: DirCrumb[]
  entries: DirEntry[]
  truncated: boolean
}

/** Windows 盘符根正则（C: / C:\ / C:/ 均可，不分大小写）。 */
const WIN_ROOT_RE = /^[A-Za-z]:[\\/]?$/

/** 判断是否为 Windows 盘符根（用于盘符切换交互）。 */
export function isWindowsRoot(name: string): boolean {
  return WIN_ROOT_RE.test(name)
}

/** 从根到 target 的祖先链（面包屑行）。Windows 盘符根显示名去尾部分隔符（C:\ → C:）。 */
export function ancestryCrumbs(target: string): DirCrumb[] {
  const crumbs: DirCrumb[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    const isRoot = parent === current
    crumbs.unshift({
      // Windows 盘符根去尾部分隔符（C:\ → C:）；Unix 根 / 保持原样。
      name: isRoot
        ? WIN_ROOT_RE.test(current)
          ? current.replace(/[\\/]$/, '')
          : current
        : basename(current),
      path: current,
      hidden: false,
    })
    if (isRoot) return crumbs
    current = parent
  }
}

/**
 * 探测 Windows 可用盘符（A-Z 逐个 access；仅 win32，否则空数组）。
 * 供「点击盘符根 crumb → 切换盘符」交互使用。
 */
export async function listWindowsRoots(): Promise<DirEntry[]> {
  if (process.platform !== 'win32') return []
  const roots: DirEntry[] = []
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const rootPath = `${letter}:\\`
    try {
      await access(rootPath, constants.F_OK)
      roots.push({ name: `${letter}:`, path: rootPath, hidden: false })
    } catch {
      /* 盘符不存在/不可访问（空光驱、未挂载网络盘）跳过 */
    }
  }
  return roots
}

/** 枚举单层子目录（符号链接跟随判定，断链/循环跳过）。 */
export async function listDirectory(path?: string): Promise<DirectoryListing> {
  const home = homedir()
  const target = resolve(path && path.trim() ? path : home)
  const raw: DirEntry[] = []
  const dir = await opendir(target)
  for await (const dirent of dir) {
    let enterable = dirent.isDirectory()
    if (!enterable && dirent.isSymbolicLink()) {
      try {
        enterable = (await stat(join(target, dirent.name))).isDirectory()
      } catch {
        /* 断链/循环链接跳过 */
      }
    }
    if (!enterable) continue
    raw.push({
      name: dirent.name,
      path: join(target, dirent.name),
      hidden: dirent.name.startsWith('.'),
    })
    if (raw.length > DIR_MAX_ENTRIES) break
  }
  raw.sort((a, b) => a.name.localeCompare(b.name))
  return {
    ok: true,
    path: target,
    home,
    crumbs: ancestryCrumbs(target),
    entries: raw.slice(0, DIR_MAX_ENTRIES),
    truncated: raw.length > DIR_MAX_ENTRIES,
  }
}

/** 在 parent 下创建单层子目录（名称为单段路径，防路径注入）。 */
export async function createDirectory(
  path: string,
  name: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    return { ok: false, error: 'invalid-name' }
  }
  const parent = resolve(path)
  const target = join(parent, name)
  try {
    await mkdir(target)
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'mkdir-failed' }
  }
}

/** 文本预览上限（超过按二进制处理，避免拖垮远端浏览器）。 */
export const FILE_PREVIEW_MAX_BYTES = 1024 * 1024

/** 文件预览结果（供远端「打开文件」浏览器内查看）。 */
export interface FilePreview {
  ok: true
  kind: 'text' | 'binary' | 'directory'
  path: string
  name: string
  size: number
  ext?: string
  text?: string
  listing?: DirectoryListing
}

/**
 * 读取文件用于远端浏览器内预览。目录返回单层列表；文本返回内容；二进制/超限返回标记。
 * 与 listDirectory 同安全边界：本机操作者浏览本机文件，等价于 dsh 官方 host.openPath，
 * 远端经 3081 反代已过 TOTP 2FA。不做路径白名单（否则无法打开任意交付物文件）。
 */
export async function readFilePreview(
  path?: string,
): Promise<FilePreview | { ok: false; error: string }> {
  if (!path || !path.trim()) return { ok: false, error: 'empty-path' }
  const target = resolve(path.trim())
  let st
  try {
    st = await stat(target)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'stat-failed' }
  }
  if (st.isDirectory()) {
    const listing = await listDirectory(target)
    return { ok: true, kind: 'directory', path: target, name: basename(target), size: 0, listing }
  }
  const ext = extname(target).slice(1).toLowerCase()
  if (st.size > FILE_PREVIEW_MAX_BYTES) {
    return { ok: true, kind: 'binary', path: target, name: basename(target), size: st.size, ext }
  }
  try {
    const buf = await readFile(target)
    // 含 NUL 字节视为二进制（UTF-8 文本不含 NUL），避免乱码渲染。
    if (buf.includes(0)) {
      return { ok: true, kind: 'binary', path: target, name: basename(target), size: st.size, ext }
    }
    return {
      ok: true,
      kind: 'text',
      path: target,
      name: basename(target),
      size: st.size,
      ext,
      text: buf.toString('utf8'),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'read-failed' }
  }
}
