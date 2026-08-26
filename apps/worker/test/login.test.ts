import { describe, expect, it, vi } from "vitest"

import { handleLogin } from "../src/auth/login"
import { encryptToken } from "../src/lib/crypto"
import type { Env } from "../src/index"

// mock GitHub 校验：默认 verifyToken 返回 invalid（模拟「GitHub 已撤销 token」），
// 让「假登录态自愈」测试可构造。现有短路测试无 user KV 条目（rawUser null →
// 降级短路），不受 mock 影响。
vi.mock("../src/lib/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/github")>()
  return {
    ...actual,
    verifyToken: vi.fn(async () => "invalid" as const),
  }
})

/** 内存 KV mock */
function createKvMock(initial: Map<string, string> = new Map()) {
  const store = initial
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k)
    }),
  } as unknown as KVNamespace
}

function makeEnv(kv: KVNamespace, base = "http://127.0.0.1:5174"): Env {
  return {
    DEEPSEA_KV: kv,
    ASSETS: {} as Fetcher,
    DEEPSEA_BASE: base,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
  }
}

describe("/auth/login", () => {
  it("未登录：302 到 GitHub authorize，state 写入 KV", async () => {
    const kv = createKvMock()
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login"),
      makeEnv(kv)
    )

    expect(res.status).toBe(302)
    const loc = res.headers.get("Location") ?? ""
    expect(loc).toContain("https://github.com/login/oauth/authorize")
    expect(loc).toContain("client_id=test-client")
    expect(loc).toContain("state=")
    const state = new URL(loc).searchParams.get("state")
    // state 已写入 KV
    expect(await kv.get(`state:${state}`)).not.toBeNull()
  })

  it("已登录（有效 session cookie）：直接 302 回站内，不再跳 GitHub", async () => {
    const kv = createKvMock(
      new Map([["session:abc", JSON.stringify({ userId: "1", createdAt: 1 })]])
    )
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login", {
        headers: { Cookie: "ds_session=abc" },
      }),
      makeEnv(kv)
    )

    expect(res.status).toBe(302)
    const loc = res.headers.get("Location") ?? ""
    expect(loc).toBe("http://127.0.0.1:5174/")
    expect(loc).not.toContain("github.com")
  })

  it("已登录 + redirect 参数：回跳指定路径", async () => {
    const kv = createKvMock(
      new Map([["session:xyz", JSON.stringify({ userId: "2", createdAt: 1 })]])
    )
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login?redirect=/plugins", {
        headers: { Cookie: "ds_session=xyz" },
      }),
      makeEnv(kv)
    )
    expect(res.headers.get("Location")).toBe("http://127.0.0.1:5174/plugins")
  })

  it("无效 session cookie：仍走 GitHub 授权", async () => {
    const kv = createKvMock() // 空 KV
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login", {
        headers: { Cookie: "ds_session=not-exist" },
      }),
      makeEnv(kv)
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toContain(
      "github.com/login/oauth/authorize"
    )
  })

  it("会话存在但 GitHub token 已失效：删会话 + 清 cookie + 重新走授权（假登录自愈）", async () => {
    // KV session 存在（30 天 TTL 未到期），但 GitHub 侧 token 已被撤销
    const tokenEnc = await encryptToken("test-secret", "stale-token")
    const kv = createKvMock(
      new Map([
        ["session:abc", JSON.stringify({ userId: "1", createdAt: 1 })],
        ["user:1", JSON.stringify({ login: "x", tokenEnc })],
      ])
    )
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login", {
        headers: { Cookie: "ds_session=abc" },
      }),
      makeEnv(kv)
    )

    expect(res.status).toBe(302)
    // 不再短路回站内，而是重新走 GitHub 授权
    expect(res.headers.get("Location")).toContain(
      "github.com/login/oauth/authorize"
    )
    // 失效会话已从 KV 删除（下次不再短路）
    expect(await kv.get("session:abc")).toBeNull()
    // 浏览器残留的失效 cookie 被强制过期（Max-Age=0）
    const sc = res.headers.get("Set-Cookie") ?? ""
    expect(sc).toContain("ds_session=")
    expect(sc).toContain("Max-Age=0")
  })

  it("外部 redirect 被拒绝（防开放重定向）", async () => {
    const kv = createKvMock()
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login?redirect=https://evil.com"),
      makeEnv(kv)
    )
    expect(res.status).toBe(400)
  })
})
