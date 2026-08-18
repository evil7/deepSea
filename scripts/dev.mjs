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

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

// eslint-disable-next-line no-underscore-dangle -- Node ESM 惯例
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const children = []

/** 启动一个子进程，输出带前缀转发到本进程 stdio */
function start(name, cwd, command, args) {
  console.log(`\n[dev] 启动 ${name}: ${command} ${args.join(" ")} (cwd=${cwd})\n`)
  const child = spawn(command, args, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: process.platform === "win32",
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

const worker = start(
  "worker",
  path.join(root, "apps", "worker"),
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["dev", "--port", "8787"]
)

const web = start(
  "web",
  path.join(root, "apps", "web"),
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["dev", "--host", "127.0.0.1", "--port", "5174"]
)

void worker
void web
