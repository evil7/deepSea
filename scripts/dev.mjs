// ---------------------------------------------------------------------------
// dev.mjs —— 同时启动 Cloudflare Worker（wrangler dev）与前端（vite dev）
//
//   用法（根目录）：pnpm dev:all
//   · Worker：apps/worker，wrangler dev --port 8787（OAuth /auth/* + KV + ASSETS）
//   · 前端：apps/web，vite dev --host 127.0.0.1 --port 5174
//     前端 /auth/* 请求由 vite 代理转发到 8787（见 vite.config.ts server.proxy）
//   · OAuth 回调：DEEPSEA_BASE=http://127.0.0.1:5174（.dev.vars 本地值）
//     → 浏览器跳回 5174/auth/callback → vite 代理到 worker
//   · 任一进程退出（含 Ctrl+C），两个子进程全部终止
// ---------------------------------------------------------------------------

import { spawn, execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createConnection } from "node:net"

// eslint-disable-next-line no-underscore-dangle -- Node ESM 惯例
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const isWin = process.platform === "win32"
const WORKER_PORT = 8787
const WEB_PORT = 5174

/* ── 端口工具（纯 Node 跨平台，参考 pureGit scripts/dev-fast.mjs） ───────── */

/** 探测端口是否被占用（TCP 连接成功 = 占用） */
function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve_) => {
    const sock = createConnection({ port, host, timeout: 1500 })
    sock.once("connect", () => {
      sock.destroy()
      resolve_(true)
    })
    sock.once("timeout", () => {
      sock.destroy()
      resolve_(false)
    })
    sock.once("error", () => resolve_(false))
  })
}

/** 按端口查找占用进程 PID（跨平台：Windows netstat / Unix lsof） */
function findPidsByPort(port) {
  return new Promise((resolve_) => {
    const pids = new Set()
    if (isWin) {
      execFile("netstat", ["-ano"], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve_([...pids])
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/\s+(\S+):(\d+)\s+\S+:\d+\s+LISTENING\s+(\d+)/)
          if (m && Number(m[2]) === port && m[3] !== "0") pids.add(m[3])
        }
        resolve_([...pids])
      })
    } else {
      execFile("lsof", ["-ti", `:${port}`], (err, stdout) => {
        if (err) return resolve_([...pids])
        for (const line of stdout.split(/\r?\n/)) {
          const pid = line.trim()
          if (/^\d+$/.test(pid)) pids.add(pid)
        }
        resolve_([...pids])
      })
    }
  })
}

/** 结束进程（Windows taskkill / Unix kill） */
function killPid(pid) {
  return new Promise((resolve_) => {
    const args = isWin ? ["/F", "/PID", String(pid)] : ["-9", String(pid)]
    execFile(isWin ? "taskkill" : "kill", args, { windowsHide: true }, () => resolve_())
  })
}

/** 等待端口释放（最多 timeoutMs；轮询语义，必须串行 await） */
async function waitPortFree(port, timeoutMs = 10_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!(await isPortInUse(port))) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return !(await isPortInUse(port))
}

/** 启动前清理：端口被占用则查找 PID 并强制结束（残留进程/上次崩溃遗留） */
async function clearPort(port, label) {
  if (!(await isPortInUse(port))) {
    console.log(`[setup] ${label} 端口 ${port} 空闲`)
    return
  }
  console.log(`[setup] ${label} 端口 ${port} 被占用，尝试清理残留进程...`)
  const pids = await findPidsByPort(port)
  if (pids.length === 0) {
    console.warn(`[warn] 未找到占用 ${port} 的进程 PID，跳过（可能为外部服务）`)
    return
  }
  for (const pid of pids) {
    console.log(`[setup] 结束进程 ${pid}（占用 ${port}）`)
    await killPid(pid)
  }
  const freed = await waitPortFree(port)
  if (!freed) {
    console.warn(`[warn] 端口 ${port} 未能释放，可能仍有子进程残留，继续尝试启动`)
  } else {
    console.log(`[setup] ${label} 端口 ${port} 已清理`)
  }
}

const children = []

/** 启动一个子进程，输出带前缀转发到本进程 stdio */
function start(name, cwd, command, args) {
  console.log(`\n[dev] 启动 ${name}: ${command} ${args.join(" ")} (cwd=${cwd})\n`)
  // shell: true + 命令字符串（避免 DEP0190：args 数组 + shell 会告警）；参数均硬编码无注入风险
  const child = spawn(`${command} ${args.join(" ")}`, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: isWin,
    env: process.env,
  })
  const prefix = `[${name}]`
  child.stdout?.on("data", (buf) => {
    for (const line of buf.toString().split("\n")) {
      if (line.trim()) console.log(`${prefix} ${line}`)
    }
  })
  child.stderr?.on("data", (buf) => {
    for (const line of buf.toString().split("\n")) {
      if (line.trim()) console.error(`${prefix} ${line}`)
    }
  })
  child.on("exit", (code, signal) => {
    console.error(`[dev] ${name} 退出 (code=${code}, signal=${signal})`)
    shutdown()
  })
  children.push(child)
  return child
}

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  // 兜底：1.5s 后强制退出本进程
  setTimeout(() => process.exit(0), 1500)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

async function main() {
  // 0) 清理端口占用（残留进程/上次崩溃遗留），保证干净启动
  await clearPort(WORKER_PORT, "worker")
  await clearPort(WEB_PORT, "web")

  // 1) 统一启动：worker → web（deepc 声纳互联已切主站同源 SW 架构，无需 snap serve）
  const worker = start(
    "worker",
    path.join(root, "apps", "worker"),
    isWin ? "pnpm.cmd" : "pnpm",
    ["dev", "--port", String(WORKER_PORT)]
  )
  const web = start(
    "web",
    path.join(root, "apps", "web"),
    isWin ? "pnpm.cmd" : "pnpm",
    ["dev", "--host", "127.0.0.1", "--port", String(WEB_PORT)]
  )
  void worker
  void web
}

main().catch((e) => {
  console.error("[dev] 启动失败:", e)
  process.exit(1)
})
