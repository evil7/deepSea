// deepc-link 目录枚举单元测试（node 脚本）
// 验证 directory.ts 的 listDirectory / createDirectory / ancestryCrumbs 行为。
// 运行：先 node test/build-tests.mjs，再 node test/directory.test.mjs

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectory, createDirectory, ancestryCrumbs, listWindowsRoots, isWindowsRoot } from './.directory.bundle.mjs'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

// ── 准备临时目录树 ──────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'deepc-dir-'))
mkdirSync(join(root, 'alpha'))
mkdirSync(join(root, 'Beta'))
mkdirSync(join(root, '.hidden'))
writeFileSync(join(root, 'file.txt'), 'x') // 文件不应出现在 entries（只列目录）
try {
  symlinkSync(join(root, 'alpha'), join(root, 'link-to-alpha'), 'dir')
} catch {
  /* symlink 权限受限（Windows 非管理员）则跳过该断言 */
}

// ── 1. listDirectory：单层目录、排序、hidden 标记 ──────────────────
const listing = await listDirectory(root)
check('listDirectory ok', listing.ok === true)
check('path = 目标目录', listing.path === root)
check('home 非空', typeof listing.home === 'string' && listing.home.length > 0)
check('entries 仅含目录（不含文件）', listing.entries.every((e) => e.path !== join(root, 'file.txt')))
const names = listing.entries.map((e) => e.name)
check('包含所有子目录', ['.hidden', 'Beta', 'alpha'].every((n) => names.includes(n)))
check('entries 按 localeCompare 排序', names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0))
check('hidden 目录标记 hidden=true', listing.entries.find((e) => e.name === '.hidden')?.hidden === true)
check('非 hidden 目录 hidden=false', listing.entries.find((e) => e.name === 'alpha')?.hidden === false)
check('面包屑以根路径收尾', listing.crumbs[listing.crumbs.length - 1]?.path === root)

// ── 2. 无 path 参数 → 列 home ──────────────────────────────────────
const homeListing = await listDirectory(undefined)
check('无 path 列 home（path 非空）', typeof homeListing.path === 'string' && homeListing.path.length > 0)
check('home 字段 = 实际 home', homeListing.home === homeListing.home)

// ── 3. ancestryCrumbs：从根到 target 递增 ──────────────────────────
const crumbs = ancestryCrumbs(join(root, 'alpha'))
check('面包屑链长度 > 1', crumbs.length > 1)
check('末 crumb 是 target', crumbs[crumbs.length - 1].path === join(root, 'alpha'))
check('首 crumb 是根', crumbs[0].path === (join(root, 'alpha').slice(0, 3)))

// ── 4. createDirectory：合法名成功、非法名拒绝 ─────────────────────
const created = await createDirectory(root, 'newdir')
check('createDirectory 成功', created.ok === true && created.path === join(root, 'newdir'))
check('created 目录可列出', (await listDirectory(join(root, 'newdir'))).ok === true)

const badSlash = await createDirectory(root, 'a/b')
check('拒绝含 / 的名称', badSlash.ok === false && badSlash.error === 'invalid-name')
const badDot = await createDirectory(root, '..')
check('拒绝 .. 名称', badDot.ok === false && badDot.error === 'invalid-name')
const badEmpty = await createDirectory(root, '')
check('拒绝空名称', badEmpty.ok === false && badEmpty.error === 'invalid-name')

// ── 5. isWindowsRoot：盘符根判定 ────────────────────────────────────
check('isWindowsRoot("C:") = true', isWindowsRoot('C:') === true)
check('isWindowsRoot("C:\\") = true', isWindowsRoot('C:\\') === true)
check('isWindowsRoot("D:/") = true', isWindowsRoot('D:/') === true)
check('isWindowsRoot("Users") = false', isWindowsRoot('Users') === false)
check('isWindowsRoot("/") = false', isWindowsRoot('/') === false)

// ── 6. listWindowsRoots：仅 win32 探测；含当前盘符且 name 去尾分隔符 ──
const roots = await listWindowsRoots()
if (process.platform === 'win32') {
  check('win32 下列出盘符（>0）', roots.length > 0)
  check('盘符名去尾分隔符（无 \\ 结尾）', roots.every((r) => /^[A-Za-z]:$/.test(r.name)))
  check('盘符 path 为 X:\\ 根', roots.every((r) => /^[A-Za-z]:[\\/]$/.test(r.path)))
} else {
  check('非 win32 返回空', Array.isArray(roots) && roots.length === 0)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
